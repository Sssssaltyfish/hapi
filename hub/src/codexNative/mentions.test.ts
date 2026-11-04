import { expect, test } from 'bun:test'
import { mentionSuggestions, nativeMessageInput } from './mentions'
import type { NativeService } from './service'
import { record } from './transport'

test('the current query receives a plugin that finishes discovery after file search', async () => {
    let finish!: (value: unknown) => void
    const plugins = new Promise((resolve) => {
        finish = resolve
    })
    const service = {
        readThread: async () => ({ thread: { cwd: '/repo' } }),
        call: async () => ({ entries: [] }),
        withConnection: async (action: (client: unknown) => Promise<unknown>) =>
            action({
                close() {},
                request: (method: string) =>
                    method === 'plugin/list' ? plugins : Promise.resolve({ data: [] }),
            }),
    } as unknown as NativeService
    let settled = false
    const current = mentionSuggestions(service, 'thread', '@late').then((value) => {
        settled = true
        return value
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    finish({
        marketplaces: [
            { plugins: [{ id: 'late@market', name: 'late', installed: true, enabled: true }] },
        ],
    })
    expect((await current).map((item) => item.key)).toEqual(['plugin://late@market'])
})

test('native message conversion preserves file references and uses typed inputs only for known entity URIs', () => {
    expect(nativeMessageInput('hello @ordinary 世界')).toEqual([
        { type: 'text', text: 'hello @ordinary 世界', text_elements: [] },
    ])
    expect(
        nativeMessageInput('$tool read @"C:\\\\用户\\\\with space\\\\a\\\"b.ts" next', [
            { name: 'tool', path: '/skills/tool/SKILL.md', enabled: true },
        ])
    ).toEqual([
        { type: 'skill', name: 'tool', path: '/skills/tool/SKILL.md' },
        {
            type: 'text',
            text: ' read @"C:\\\\用户\\\\with space\\\\a\\\"b.ts" next',
            text_elements: [],
        },
    ])
    expect(
        nativeMessageInput(
            'Use @"plugin://visualize@market" and @"app://connector" with @"/my folder/文件".'
        )
    ).toEqual([
        { type: 'text', text: 'Use ', text_elements: [] },
        { type: 'mention', name: 'visualize@market', path: 'plugin://visualize@market' },
        { type: 'text', text: ' and ', text_elements: [] },
        { type: 'mention', name: 'connector', path: 'app://connector' },
        { type: 'text', text: ' with @"/my folder/文件".', text_elements: [] },
    ])
    expect(
        nativeMessageInput('$disabled plain', [
            { name: 'disabled', path: '/disabled', enabled: false },
        ])[0].text
    ).toBe('$disabled plain')
})

test('suggestions use the native workspace root and discover only enabled skills and installed enabled plugins/apps', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const service = {
        readThread: async () => ({ thread: { cwd: '/repo' } }),
        call: async (method: string, params: unknown) => {
            calls.push({ method, params })
            if (method === 'fs/readDirectory')
                return {
                    entries: [
                        { fileName: '世界.ts', isFile: true },
                        { fileName: 'src', isDirectory: true },
                        { fileName: '../outside', isFile: true },
                    ],
                }
            if (method === 'skills/list')
                return {
                    data: [
                        {
                            skills: [
                                { name: 'ready', path: '/skill/SKILL.md', enabled: true },
                                { name: 'disabled', path: '/disabled', enabled: false },
                            ],
                        },
                    ],
                }
            return {
                files: [
                    { path: 'src/世界.ts', file_name: '世界.ts', match_type: 'file' },
                    { path: 'src', file_name: 'src', match_type: 'directory' },
                    { path: '../outside', file_name: 'outside', match_type: 'file' },
                ],
            }
        },
        withConnection: async (action: (client: unknown) => Promise<void>) =>
            action({
                close() {},
                request: async (method: string) =>
                    method === 'plugin/list'
                        ? {
                              marketplaces: [
                                  {
                                      plugins: [
                                          {
                                              id: 'ok@market',
                                              name: 'ok',
                                              installed: true,
                                              enabled: true,
                                          },
                                          {
                                              id: 'no@market',
                                              name: 'no',
                                              installed: false,
                                              enabled: true,
                                          },
                                      ],
                                  },
                              ],
                          }
                        : {
                              data: [
                                  {
                                      id: 'app',
                                      name: 'Available app',
                                      isAccessible: true,
                                      isEnabled: true,
                                  },
                                  { id: 'no', name: 'Unavailable', isAccessible: false },
                              ],
                          },
            }),
    } as unknown as NativeService
    await mentionSuggestions(service, 'thread', '@')
    const suggestions = await mentionSuggestions(service, 'thread', '@')
    expect(suggestions.map((item) => item.key)).toEqual([
        '/repo/世界.ts',
        '/repo/src',
        'plugin://ok@market',
        'app://app',
    ])
    expect(
        (await mentionSuggestions(service, 'thread', '@src')).map((item) => item.key)
    ).not.toContain('/outside')
    expect(record(calls.find((call) => call.method === 'fuzzyFileSearch')!.params).roots).toEqual([
        '/repo',
    ])
    expect((await mentionSuggestions(service, 'thread', '$')).map((item) => item.text)).toEqual([
        '$ready',
    ])
})
