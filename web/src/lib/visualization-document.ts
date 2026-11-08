import { startVisualizationRuntime, type VisualizationGlobals } from './visualization-runtime'
import stylesheet from './visualization.css?inline'

export type { VisualizationGlobals } from './visualization-runtime'

const staticResources = [
    'https://cdnjs.cloudflare.com',
    'https://esm.sh',
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://persistent.oaistatic.com/plugins/visualize/',
].join(' ')

const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${staticResources}`,
    `style-src 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net ${staticResources}`,
    `img-src data: blob: ${staticResources}`,
    `font-src https://fonts.gstatic.com https://fonts.bunny.net ${staticResources}`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
].join('; ')

export function buildVisualizationDocument(html: string, bridgeId: string, globals: VisualizationGlobals): string {
    const config = JSON.stringify({ bridgeId, globals, icons: /\b(?:data-lucide|lucide)\b/.test(html) })
        .replace(/</g, '\\u003c')

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="referrer" content="no-referrer">
<style>${stylesheet}</style>
<script id="hapi-visualization-config" type="application/json">${config}</script>
<script>(${startVisualizationRuntime.toString()})();</script>
</head>
<body>
${html}
</body>
</html>`
}
