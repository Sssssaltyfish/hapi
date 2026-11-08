import { QueryClient } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { applySuggestion } from '@/utils/applySuggestion'
import { getRunnerWorkspaceSuggestions } from './runnerWorkspaceSuggestions'

function makeApi(scope: string) {
    const searchSessionFiles = vi.fn(async () => ({ success: true, files: [
        { fileName: 'Read Me.md', filePath: 'docs', fullPath: 'docs/Read Me.md', fileType: 'file' },
    ] }))
    const listSessionDirectory = vi.fn(async () => ({ success: true, entries: [
        { name: 'Recipes', type: 'directory' }, { name: 'Read Me.md', type: 'file' },
    ] }))
    const api = { searchSessionFiles, listSessionDirectory, getConversationCacheScope: () => ({ key: scope }) } as unknown as ApiClient
    return { api, searchSessionFiles, listSessionDirectory }
}

it.each(['agy', 'dsh', 'claude'] as const)('completes runner files and folders for %s as workspace paths', async flavor => {
    const { api, searchSessionFiles, listSessionDirectory } = makeApi('hub')
    const client = new QueryClient()
    const suggestions = await getRunnerWorkspaceSuggestions(api, client, 'session', '/work', flavor, './docs/Re')

    expect(searchSessionFiles).toHaveBeenCalledWith('session', 'docs/Re', 50)
    expect(listSessionDirectory).toHaveBeenCalledWith('session', 'docs/')
    expect(suggestions).toEqual([
        expect.objectContaining({ group: 'files', text: '"docs/Read Me.md"' }),
        expect.objectContaining({ group: 'folders', text: '"docs/Recipes"' }),
    ])
    const draft = 'inspect @./docs/Re'
    expect(applySuggestion(draft, { start: draft.length, end: draft.length }, suggestions[0].text).text)
        .toBe('inspect "docs/Read Me.md" ')
    client.clear()
})

it('reuses folder searches on the same endpoint and keeps native path syntax', async () => {
    const first = makeApi('first hub')
    const second = makeApi('second hub')
    const client = new QueryClient()
    const complete = (api: ApiClient, flavor: 'codex' | 'copilot', search: string) =>
        getRunnerWorkspaceSuggestions(api, client, 'session', 'C:\\work', flavor, search)

    const codex = await complete(first.api, 'codex', 'docs\\R')
    const copilot = await complete(first.api, 'copilot', 'docs\\Re')
    await complete(second.api, 'codex', 'docs\\Re')
    expect(first.listSessionDirectory).toHaveBeenCalledTimes(1)
    expect(second.listSessionDirectory).toHaveBeenCalledWith('session', 'docs/')
    expect(codex[0].text).toBe('@"docs/Read Me.md"')
    expect(copilot[1].text).toBe('@docs/Recipes')
    client.clear()
})
