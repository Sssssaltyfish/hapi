import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
            selection: vi.fn()
        }
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key === 'tool.otherDescription' ? '自己填写' : key })
}))

import { RequestUserInputFooter } from './RequestUserInputFooter'

const choice = { id: 'choice', question: 'Choose', isOther: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }

function renderFooter(input: unknown = { questions: [choice] }, permissionId = 'permission-1') {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    const props = {
        api: { approvePermission, denyPermission } as unknown as ApiClient,
        sessionId: 'session-1', tool: makeTool(input, permissionId), disabled: false, onDone: vi.fn()
    }
    return { ...render(<RequestUserInputFooter {...props} />), props, approvePermission, denyPermission }
}

function makeTool(input: unknown, permissionId = 'permission-1'): ChatToolCall {
    return {
        id: 'request-1',
        name: 'request_user_input',
        state: 'pending',
        input,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: {
            id: permissionId,
            status: 'pending'
        }
    }
}

describe('RequestUserInputFooter', () => {
    it('focuses the custom answer and requires text before submitting canonical values', async () => {
        const { approvePermission } = renderFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: /自己填写/ }))
        expect(screen.getByRole('textbox')).toHaveFocus()
        expect(screen.getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('button', { name: /自己填写/ })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByRole('alert')).toHaveTextContent('tool.selectOption')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '  自定义\n说明  ' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', 'user_note: 自定义\n说明'] } }
        }))
    })

    it('retains notes across choices, questions, and SSE rerenders without auto-advancing', async () => {
        const { props, rerender, approvePermission } = renderFooter({ questions: [choice, { ...choice, id: 'second', question: 'Second' }] })
        fireEvent.click(screen.getByRole('button', { name: /自己填写/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this note' } })
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        expect(screen.getByRole('button', { name: /自己填写/ })).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: /自己填写/ }))
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        expect(screen.getByText('Choose')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'supplementary detail' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.prev' }))
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, input: structuredClone(props.tool.input) }} />)
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        expect(screen.getByRole('button', { name: /自己填写/ })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', 'user_note: keep this note'] }, second: { answers: ['Beta', 'user_note: supplementary detail'] } }
        }))
    })

    it('does not interpret a note alone as None of the above', () => {
        const { approvePermission } = renderFooter()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'custom' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByText('tool.selectOption')).toBeInTheDocument()
    })

    it.each([false, undefined])('does not add other to Pi or MCP choices (%s)', (isOther) => {
        renderFooter({ questions: [{ ...choice, isOther }] })
        expect(screen.queryByRole('button', { name: /自己填写/ })).not.toBeInTheDocument()
    })

    it('retains the answer on failure and removes controls when resolved elsewhere', async () => {
        const { props, rerender, approvePermission } = renderFooter()
        approvePermission.mockRejectedValueOnce(new Error('try again'))
        fireEvent.click(screen.getByRole('button', { name: /自己填写/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByText('try again')
        expect(screen.getByRole('textbox')).toHaveValue('draft')
        expect(screen.getByRole('button', { name: /自己填写/ })).toHaveAttribute('aria-pressed', 'true')
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, permission: { id: 'permission-1', status: 'resolved' } }} />)
        expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
        expect(approvePermission).toHaveBeenCalledTimes(1)
    })

    it('dismisses the request without submitting or opening a selected sign-in URL', async () => {
        const url = 'https://example.com/login'
        const open = vi.spyOn(window, 'open')
        try {
            const { approvePermission, denyPermission } = renderFooter({ url, questions: [{
                id: '__mcp_url_confirmation', question: 'Sign in', options: [{ label: 'Open', description: url }]
            }] })
            fireEvent.click(screen.getByRole('button', { name: /Open/ }))
            fireEvent.click(screen.getByRole('button', { name: 'tool.dismissQuestion' }))
            await waitFor(() => expect(screen.queryByRole('button', { name: 'tool.dismissQuestion' })).not.toBeInTheDocument())
            expect(denyPermission).toHaveBeenCalledWith('session-1', 'permission-1', { decision: 'abort' })
            expect(approvePermission).not.toHaveBeenCalled()
            expect(open).not.toHaveBeenCalled()
        } finally {
            open.mockRestore()
        }
    })

    it('reuses a supplied Other option and submits Native async custom text without metadata', async () => {
        const { approvePermission } = renderFooter({ questions: [{
            ...choice, options: [...choice.options, { label: 'Other' }]
        }] }, 'native-async:question')
        expect(screen.queryByRole('button', { name: 'Other' })).not.toBeInTheDocument()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'regular choice note' } })
        fireEvent.click(screen.getByRole('button', { name: /自己填写/ }))
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '  My own answer  ' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'native-async:question', {
            answers: { choice: { answers: ['My own answer'] } }
        }))
    })

    it('keeps a Native async supplementary note with a predefined choice', async () => {
        const { approvePermission } = renderFooter({ questions: [choice] }, 'native-async:question')
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'regular choice note' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'native-async:question', {
            answers: { choice: { answers: ['Alpha', 'user_note: regular choice note'] } }
        }))
    })

    it('uses a Pi extension pure-text placeholder and prefill when initializing the request', () => {
        render(
            <RequestUserInputFooter
                api={{} as ApiClient}
                sessionId="session-1"
                tool={makeTool({
                    questions: [{
                        id: 'comment',
                        question: 'Comment',
                        options: [],
                        placeholder: 'Describe the change',
                        prefill: 'Initial draft'
                    }]
                })}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        const textarea = screen.getByRole('textbox')
        expect(textarea).toHaveAttribute('placeholder', 'Describe the change')
        expect(textarea).toHaveValue('Initial draft')
    })
})
