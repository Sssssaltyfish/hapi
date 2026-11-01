import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_TOOL_GROUPS_COLLAPSED,
    getInitialToolGroupsCollapsed,
    useToolGroupCollapse,
} from './useToolGroupCollapse'

const STORAGE_KEY = 'hapi-codex-exploration-collapsed'

describe('useToolGroupCollapse helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to collapsed', () => {
        expect(getInitialToolGroupsCollapsed()).toBe(DEFAULT_TOOL_GROUPS_COLLAPSED)
    })

    it('reads valid stored values and ignores invalid values', () => {
        window.localStorage.setItem(STORAGE_KEY, 'false')
        expect(getInitialToolGroupsCollapsed()).toBe(false)

        window.localStorage.setItem(STORAGE_KEY, 'invalid')
        expect(getInitialToolGroupsCollapsed()).toBe(DEFAULT_TOOL_GROUPS_COLLAPSED)
    })
})

describe('useToolGroupCollapse', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('persists the expanded preference', () => {
        const { result } = renderHook(() => useToolGroupCollapse())

        act(() => {
            result.current.setToolGroupsCollapsed(false)
        })

        expect(result.current.toolGroupsCollapsed).toBe(false)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false')
    })

    it('removes the stored preference when restored to the default', () => {
        window.localStorage.setItem(STORAGE_KEY, 'false')
        const { result } = renderHook(() => useToolGroupCollapse())

        act(() => {
            result.current.setToolGroupsCollapsed(true)
        })

        expect(result.current.toolGroupsCollapsed).toBe(true)
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('applies cross-tab changes from storage events', () => {
        const { result } = renderHook(() => useToolGroupCollapse())

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: 'false',
            }))
        })

        expect(result.current.toolGroupsCollapsed).toBe(false)

        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: null,
            }))
        })

        expect(result.current.toolGroupsCollapsed).toBe(true)
    })
})
