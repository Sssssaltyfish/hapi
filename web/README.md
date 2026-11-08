# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Codex `request_user_input` choices honor `isOther`: **None of the above**
  focuses optional notes, supports empty notes, and preserves the canonical
  wire value across languages. Recorded other answers and notes remain visible
  in live and historical cards; Pi/MCP forms without the flag are unchanged.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.
- Optional unread-session count on the Windows taskbar when installed as an Edge/Chrome PWA (toggleable in Display settings; off by default).

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with `CLI_API_TOKEN:<namespace>` (or `CLI_API_TOKEN` for the default namespace).
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the hub via SSE.
- Codex Native reasoning summaries retain the daemon's indexed parts and join
  adjacent tools and subagent activity in the same collapsible group. A summary
  that fits on one rendered line stays inline; longer summaries have their own
  disclosure. Manual expansion survives streaming and history pagination within
  the session.
- Session `@` suggestions require conversation content, including untitled conversations. Names and directory labels affect display/search, not eligibility; empty stubs stay excluded.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/browse` - Workspace browser, enabled by the runner's configured workspace roots.
- `/share` - Share-target landing (Web Share Target POST → `?id=`, or native `/share#url=&text=&title=`).
- `/settings` - Settings category hub (mobile) and responsive master-detail shell.
- `/settings/general` - Language preferences.
- `/settings/display` - Appearance, typography, colors, and session list preferences.
- `/settings/chat` - Message input, tool card, and conversation color preferences.
- `/settings/voice` - Everyday voice assistant preferences.
- `/settings/voice/voices` - Full-page voice picker.
- `/settings/voice/advanced` - Voice persona, tuning, and diagnostics.
- `/settings/machines` - Machine management and runner status.
- `/settings/storage` - SQLite storage sizes for the hub owner.
- `/settings/usage` - Cache-aware token usage dashboard for the hub owner.
- `/settings/about` - Application links and version information.

## Features

### App icon

In Display settings, the hub owner (default namespace) can choose an image,
position a square crop by dragging or using arrow keys, and adjust its zoom.
The browser exports only the crop as a 512 × 512 WebP at quality 80; the original
image stays in browser memory and is never uploaded. Keeping 512 pixels preserves
PWA installation quality while WebP reduces the saved and transferred bytes.
Tabs and the settings preview fetch a 64-pixel derivative. The custom manifest
provides real 192- and 512-pixel images for installation; the smaller images are
generated on demand from the single stored master.
When a browser cannot encode Canvas WebP (including Safari), its cropped PNG
fallback is sent with its actual MIME type and converted by the hub. New saves
keep one `app-icon.webp`, replacing it on each save and removing any legacy
`app-icon.png`. Existing PNG icons remain readable until replaced or reset.
Restore default removes both supported storage filenames.

The icon applies across the hub to browser tabs and newly installed mobile
PWAs when the hub serves the frontend. Image and manifest reads are public so
browsers can install without an API token; changes require owner authentication.
The generated manifest retains its existing start URL, scope, and share target,
and reports the stored image's actual MIME type. Apple touch icons use a 180-pixel
PNG generated on demand from the latest icon, with no extra file retained.
Image responses use revision ETags and browser revalidation so repeated requests
can return 304 before decoding or resizing the master again.
Image conversion uses `Bun.Image` (Bun 1.3.14 or later; the project pins Bun 1.4).
Installed apps may update their icon later or require removal and reinstallation
(including adding the app to the home screen again on iOS).

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent name and model display.
- A workspace's plus button carries its machine, directory, and provider into
  New Session. Native daemon projects also retain their project assignment.

### Browser appearance

Display settings can save, rename, delete, import, and export custom color
schemes. Each scheme includes its base preset, per-appearance color overrides,
and an optional background image with brightness and blur. Images and saved
schemes stay in this browser's IndexedDB; exported JSON includes the image.

### Inline media

Assistant Markdown and generated media use inline image, audio, and video
players. Remote audio/video URLs use the browser's media loader. Local audio
and video use short-lived, file-scoped media tickets and HTTP byte ranges;
runner files are read in bounded chunks and stop reading when playback requests
are canceled.

Codex Native currently exposes only whole-file `fs/readFile`. Its first media
request imports the file into an expiring disk cache; later seeks read byte
ranges from that snapshot. The cache bounds idle storage and concurrent imports,
but a single large file can exceed its storage target while it is in use.

### Side questions

`/btw` opens a compact side-question panel; `/btw <question>` starts the question
immediately. The main composer remains available. Side answers can be minimized,
canceled, or closed and are not appended to the main conversation. Leaving a
conversation cancels its pending side question.

Codex Native and capable Codex runners use a temporary, tool-free daemon thread
with a bounded excerpt of visible conversation and tool results. Claude runners
prefer Claude Code's native side-question control, with a nonpersistent,
tool-free fork when the live control is unavailable. Other runners expose this
command only when their adapter declares the corresponding capability.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode and model selection for supported agents.
  Cursor Auto uses CLI Auto for new/resumed sessions configured with Auto. When ACP does not advertise a literal Auto option, the session picker warns that switching back from a concrete model requires a restart; HAPI does not automatically restart an active session.
- Session abort and handoff controls.
- Codex **Continue planning** hides the current proposal's action menu locally
  and focuses the composer without sending a message or replacing its draft.
  The plan document remains readable; recycled cards stay dismissed and new
  proposals get fresh action menus.
- Context size display.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Entries and attachments saved on the hub and synced across devices.
  - Reordering affects only the current view and resets when entries refresh.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js
- Real-time via Socket.IO `/terminal`
- Resize handling

### Voice assistant

- ElevenLabs (@elevenlabs/react), Gemini Live, and Qwen Realtime backends
- Real-time voice control
- Standard and realtime composer dictation with provider capability selection

### New session (`src/components/NewSession/`)

Modular session creation:

- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Per-agent permission, effort, and collaboration controls when supported

### First-User-Experience (FUE)

For a new, non-essential feature whose affordance would otherwise be hard to
discover, consider the existing FUE primitive rather than a permanent UI block.
Optional, not a requirement for every feature or a reason to expand a bug fix.

- `src/lib/use-fue.ts`: `useFue(featureId)` returns `{ status, engage, dismiss }`; acknowledgement is isolated per feature in `hapi.fue.v1.<featureId>` localStorage keys.
- `src/components/Fue.tsx`: `FueDot` marks the affordance; `FueCallout` explains it while `status === 'engaging'`.
- Dismissal requires an affirmative user action ("Got it"), never an auto-timeout.
- The FUE dot and feature-specific badges/counters are mutually exclusive; onboarding wins until acknowledged.
- Opt in per feature; skip the wrapper if an upstream component already supplies onboarding.
- Working example: `ScratchlistToggleButton` in `src/components/AssistantChat/ComposerButtons.tsx`. Use the source rather than maintaining a copied example here.

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses CLI_API_TOKEN from login prompt.
- JWT tokens with auto-refresh.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


If testing in Telegram, set:

- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

End-to-end browser tests for the scratchlist component (real Chromium, real
`inert` focus blocking, real localStorage round-trips) live at the repo root
under `e2e/`:

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The spec drives a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the hapi hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.
