import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { ToolCard } from './ToolCard'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))

function makeBlock(name: string, input: unknown): ToolCallBlock {
    return {
        kind: 'tool-call', id: `minimal-${name}`, localId: null, createdAt: 1000, children: [],
        tool: { id: `minimal-${name}`, name, input, state: 'completed', createdAt: 1000, startedAt: 1000, completedAt: 2000, execStartedAt: null, execCompletedAt: null, description: 'Friendly narration', result: 'command-output' },
    }
}

function renderCard(block: ToolCallBlock, api = {} as ApiClient) {
    return render(<I18nProvider><ToolCard api={api} sessionId="session" metadata={{ path: '/repo', host: 'host', flavor: 'codex' }} terminalToolDisplayMode="minimal" disabled={false} onDone={vi.fn()} block={block} /></I18nProvider>)
}

describe('minimal tool display', () => {
    afterEach(cleanup)

    it.each([
        { name: 'Bash', input: { command: 'printf "hello"\npwd' }, preview: 'printf "hello" ↵ pwd' },
        { name: 'CodexBash', input: { command: ['git', 'status', '--short'] }, preview: 'git status --short' },
        { name: 'shell_command', input: { command: 'python script.py --check' }, preview: 'python script.py --check' },
        { name: 'exec_command', input: { cmd: 'rg "pattern" src' }, preview: 'rg "pattern" src' },
    ])('shows the actual $name command on one line and opens the existing details', ({ name, input, preview }) => {
        const view = renderCard(makeBlock(name, input))
        const text = screen.getByText(preview)
        expect(text).toHaveClass('truncate', 'whitespace-nowrap')
        expect(screen.queryByText('Friendly narration')).not.toBeInTheDocument()
        expect(view.container).not.toHaveTextContent('command-output')
        expect(screen.getAllByRole('button')).toHaveLength(1)
        const trigger = screen.getByRole('button', { expanded: false })
        fireEvent.click(trigger)
        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('dialog')).toHaveTextContent('command-output')
    })

    it('gives file operations and unknown provider tools a useful operation preview', () => {
        const file = renderCard(makeBlock('Read', { file_path: '/repo/src/file.ts' }))
        expect(screen.getByText('Read · /repo/src/file.ts')).toHaveClass('truncate', 'whitespace-nowrap')
        file.unmount()
        renderCard(makeBlock('mcp__tools__search', { query: 'current docs', path: '/repo' }))
        expect(screen.getByText('MCP: Tools Search · current docs · /repo')).toHaveClass('truncate', 'whitespace-nowrap')
    })

    it('keeps a visible pending approval marker and the approval action in details', async () => {
        const block = makeBlock('CodexBash', { command: 'bun test' })
        block.tool.state = 'pending'
        block.tool.permission = { id: 'approval', status: 'pending' }
        const approve = vi.fn().mockResolvedValue(undefined)
        renderCard(block, { approvePermission: approve } as unknown as ApiClient)
        expect(screen.getByText('Waiting for approval…')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes' }))
        await waitFor(() => expect(approve).toHaveBeenCalledWith('session', 'approval', { decision: 'approved' }))
    })

    it('keeps pending question choices reachable from the one-line preview', () => {
        const block = makeBlock('AskUserQuestion', { questions: [{ header: 'Choose', question: 'Choose a path', options: [{ label: 'Alpha' }, { label: 'Beta' }], multiSelect: false }] })
        block.tool.permission = { id: 'question', status: 'pending' }
        renderCard(block)
        expect(screen.getByText('Waiting for answer…')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        expect(within(screen.getByRole('dialog')).getByRole('radio', { name: /Alpha/ })).toBeEnabled()
    })
})
