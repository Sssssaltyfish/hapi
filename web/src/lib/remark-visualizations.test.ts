import { toHtml } from 'hast-util-to-html'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type PluggableList } from 'unified'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_PLUGINS, MARKDOWN_PLUGINS_WITH_VISUALIZATIONS } from '@/components/assistant-ui/markdown-text'
import type { VisualizationReference } from './remark-visualizations'

const marker = (reference: VisualizationReference) => `\uE200visualize\uE202${JSON.stringify(reference)}\uE201`

function render(markdown: string, plugins: PluggableList = MARKDOWN_PLUGINS_WITH_VISUALIZATIONS) {
    const processor = unified().use(remarkParse).use(plugins).use(remarkRehype)
    return toHtml(processor.runSync(processor.parse(markdown), markdown) as never)
}

describe('assistant visualization references', () => {
    it('preserves JSON punctuation, both absolute path styles, and surrounding prose', () => {
        const windows = marker({ path: 'C:\\Users\\a\\x_y_[1].HTML', title: '*Title* \uE201 `label`', mode: 'wide' })
        const posix = marker({ path: '/work/a b/demo.htm' })
        const html = render(`Before ${windows} **between** ${posix} after`)
        expect(html.match(/<hapi-visualization/g)).toHaveLength(2)
        expect(html).toContain('data-path="C:\\Users\\a\\x_y_[1].HTML"')
        expect(html).toContain('data-mode="wide"')
        expect(new DOMParser().parseFromString(html, 'text/html').querySelector('hapi-visualization')?.getAttribute('title')).toBe('*Title* \uE201 `label`')
        expect(html).toContain('data-path="/work/a b/demo.htm"')
        expect(html).toContain('Before <hapi-visualization')
        expect(html).toContain('</hapi-visualization> <strong>between</strong> <hapi-visualization')
        expect(html).toContain('</hapi-visualization> after')
    })

    it('only recognizes complete local HTML references in enabled prose', () => {
        const valid = marker({ path: '/work/example.html' })
        const code = `\`${valid}\`\n\n\`\`\`text\n${valid}\n\`\`\``
        expect(render(code)).not.toContain('<hapi-visualization')
        expect(render(`[${valid}](https://example.test)`)).not.toContain('<hapi-visualization')
        expect(render(valid, MARKDOWN_PLUGINS)).not.toContain('<hapi-visualization')
        expect(render(valid.slice(0, -1))).not.toContain('<hapi-visualization')
        for (const path of ['example.html', 'https://example.test/demo.html', '//example.test/demo.html', '/work/demo.svg']) {
            expect(render(marker({ path }))).not.toContain('<hapi-visualization')
        }
    })

    it('renders standalone references emitted without Codex delimiters', () => {
        const claude = 'visualize{"path":"/home/igna/codex-work/visualize/harmonograph.html","title":"Harmonograph"}'
        const agy = 'visualize{"path":"/home/igna/codex-work/fourier-epicycles.html","title":"Fourier"}'
        const windows = `visualize${JSON.stringify({ path: 'C:\\work\\a_b_[1].html', title: '*Title* `label`', mode: 'wide' })}`
        const html = render(`Before\n\n${claude}\n\n${agy}\n\n${windows}\n\nAfter`)
        const nodes = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('hapi-visualization')
        expect([...nodes].map(node => node.getAttribute('data-path'))).toEqual([
            '/home/igna/codex-work/visualize/harmonograph.html',
            '/home/igna/codex-work/fourier-epicycles.html',
            'C:\\work\\a_b_[1].html',
        ])
        expect(nodes[2].getAttribute('title')).toBe('*Title* `label`')
        expect(nodes[2].getAttribute('data-mode')).toBe('wide')
    })

    it('leaves portable examples and incomplete references as ordinary Markdown', () => {
        const reference = 'visualize{"path":"/work/example.html"}'
        for (const markdown of [
            `Before ${reference}`, `${reference}\nAfter`, `\`${reference}\``,
            `\`\`\`text\n${reference}\n\`\`\``, `> ${reference}`, `- ${reference}`,
            `[${reference}](https://example.test)`, reference.slice(0, -1),
            'visualize{"path":"https://example.test/widget.html"}',
        ]) {
            expect(render(markdown)).not.toContain('<hapi-visualization')
        }
        expect(render(reference, MARKDOWN_PLUGINS)).not.toContain('<hapi-visualization')
    })
})
