import { describe, expect, it } from 'vitest'
import { selectedBrowserDirectorySearch, sessionCreationBrowseSearch } from './sessionCreationBrowse'

describe('session creation Browse route search', () => {
    it('preserves an explicitly empty directory when returning to a cleared form', () => {
        expect(sessionCreationBrowseSearch({ directory: '', nativeEndpointId: 'wsl', browseDraftId: 'cleared' })).toEqual({ directory: '', nativeEndpointId: 'wsl', browseDraftId: 'cleared' })
    })
    it.each([
        { nativeEndpointId: 'windows', directory: 'C:\\Work', shareTransferId: 'share-1', browseDraftId: 'form-draft' },
        { machineId: 'runner', directory: '/projects/current', shareTransferId: 'share-1', browseDraftId: 'form-draft' },
    ])('preserves the selected target and shared attachment transfer on both route legs', context => {
        const outbound = sessionCreationBrowseSearch(Object.fromEntries(new URLSearchParams(Object.entries(context))))
        const id = context.nativeEndpointId ?? context.machineId!
        expect(selectedBrowserDirectorySearch(id, '/chosen', outbound)).toEqual({
            ...('nativeEndpointId' in context ? { nativeEndpointId: id } : { machineId: id }),
            directory: '/chosen', shareTransferId: 'share-1', browseDraftId: 'form-draft',
        })
    })

    it('keeps the assigned Native workspace scoped to its endpoint during Browse', () => {
        const context = sessionCreationBrowseSearch({
            directory: '/repo', nativeEndpointId: 'wsl', nativeProjectId: 'project', nativeProjectName: 'Workspace',
        })
        expect(selectedBrowserDirectorySearch('wsl', '/repo/subfolder', context)).toEqual({ ...context, directory: '/repo/subfolder' })
        expect(selectedBrowserDirectorySearch('windows', 'C:\\Work', context)).toEqual({ nativeEndpointId: 'windows', directory: 'C:\\Work' })
    })
})
