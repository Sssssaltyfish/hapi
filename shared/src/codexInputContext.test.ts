import { expect, it } from 'bun:test'
import { NATIVE_THREAD_REFERENCES_HEADER, NATIVE_THREAD_REFERENCES_INSTRUCTIONS } from './sessionCitation'
import { serializeResponseAnnotations, codexInputDisplayText, splitCodexInputContext } from './codexInputContext'

const references = [{ hostId: 'local', threadId: 'thread-1' }]
const referencePrefix = `${NATIVE_THREAD_REFERENCES_HEADER}\n${NATIVE_THREAD_REFERENCES_INSTRUCTIONS}\n${JSON.stringify(references)}\n`

it('projects Desktop context once, preserving the user request, selected text and notes', () => {
    const annotations = [{ text: 'Selected text', annotation: 'Explain this' }]
    const body = 'See [other chat](thread://thread-1?hostId=local).\n## My request:\nThis heading is my text.'
    const wire = serializeResponseAnnotations(`${referencePrefix}\n## My request:\n${body}`, annotations)
    expect(splitCodexInputContext(wire)).toEqual({ body, annotations, references })
    expect(splitCodexInputContext(wire.replace('# Response annotations:', '## Response annotations:'))).toEqual({ body, annotations, references })
    expect(codexInputDisplayText(wire)).toBe(`Selected text\nExplain this\n\n${body}`)
})

it('keeps examples, malformed context and ordinary request headings visible', () => {
    for (const text of [
        `Example:\n${referencePrefix}## My request:\nbody`,
        referencePrefix.replace('"local"', '42') + '## My request:\nbody',
        '## My request:\nUser-authored heading',
        '# Response annotations:\n<response-annotations>\nnot-json\n</response-annotations>\n## My request:\nbody',
    ]) expect(splitCodexInputContext(text)).toEqual({ body: text, annotations: [], references: [] })
})
