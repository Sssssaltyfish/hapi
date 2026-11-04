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
})
