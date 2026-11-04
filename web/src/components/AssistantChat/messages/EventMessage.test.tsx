import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { EventMessage } from './EventMessage'

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ metadata: { nativeCodex: { endpointId: 'windows' } } }),
}))
vi.mock('@tanstack/react-router', () => ({
    Link: ({ params, children }: { params: { sessionId: string }; children: ReactNode }) => (
        <a href={`/sessions/${encodeURIComponent(params.sessionId)}`}>{children}</a>
    ),
}))
afterEach(cleanup)

it('keeps the child link and recorded model details available in a concise historical activity', () => {
    render(<EventMessage event={{
        type: 'agent-activity', sourceItemId: 'native-item', agentId: 'child-thread',
        activityKind: 'interacted', summary: '/root/reviewer', agentPath: '/root/reviewer',
        model: 'gpt-6.1-sol', reasoningEffort: 'high',
    }} />)
    expect(screen.getByText('Interacted with /root/reviewer')).toBeDefined()
    expect(screen.getByRole('link', { name: 'child-thread', hidden: true }).getAttribute('href')).toBe('/sessions/codex-native%3Awindows%3Achild-thread')
    expect(screen.getByText('gpt-6.1-sol')).toBeDefined()
    expect(screen.getByText('high')).toBeDefined()
    expect(screen.queryByText('Running')).toBeNull()
})
