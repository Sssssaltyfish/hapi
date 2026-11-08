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
})
