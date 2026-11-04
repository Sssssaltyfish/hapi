# Native Codex mode

## Purpose and boundary

Native mode is an opt-in web client for an existing Codex app-server. It is additive to HAPI's original Codex provider. The daemon owns threads, messages, queued inputs, settings, pending requests, and execution state. The bridge must not insert those into HAPI's session/message database or run a second daemon. HAPI continues to own web authentication and namespace access.

Project filters and browser drafts are client preferences, not a second conversation store. Opening a conversation must neither create a native thread nor start a model turn. Closing the browser must release bridge subscriptions without cancelling native work.

## Implementation contract

- Reuse HAPI's existing `/sessions` list, `/sessions/:id` chat, header, message renderer, composer, file viewer and new-session form. The authenticated `/api/codex-native` APIs supply a transport adapter; they do not define a second chat interface. `/codex-native` only redirects old bookmarks to `/sessions`.
- Represent daemon threads as ephemeral session summaries and render native items through the existing message pipeline in memory. Synthetic IDs contain the configured endpoint identity and native thread ID. Keep old HAPI IDs only as explicit, namespace-scoped aliases; an unavailable endpoint must never fall back to the old executor.
- Configure an existing socket and its authorized HAPI namespace explicitly. Do not expose a caller-selected socket, arbitrary native RPC method, or another namespace's connection.
- Read Desktop project assignments and worktree identities when available. Preserve native titles. When project detection fails, quietly show manually selectable ordinary candidates, excluding exec, subagents and agent-started records. Known Desktop membership takes priority over these fallback provenance exclusions.
- List thread metadata using native cursors. Load optional background/child catalogs only when expanded. Do not scan JSONL transcripts or load child histories to build a sidebar.
- Read history using `thread/items/list`, newest first, retaining native cursors and original item timestamps. A single turn may contain thousands of items, so full-turn pages do not satisfy this requirement.
- Attach only the opened thread using a verified bounded-history protocol. History loading must not block model controls, question forms or native execution status. Do not replay history on reconnect; refresh native metadata and the bounded visible window.
- Keep only bounded, disposable connection/request caches in the server. Limit browser history pages and preserve scroll position when prepending an older page. Eviction must not silently break navigation back toward the newest page.
- Forward native mutations to the same thread. Use native input IDs for acknowledgement/idempotency where supported; do not implement a second durable delivery queue. Report ambiguous transport failures rather than automatically duplicating a send.
- Audit existing composer and menu actions by capability. Native rename/archive, model/effort, interrupt and question responses target the daemon. Disable HAPI-only import, stored transcript export, scratchlist, scheduling, fork/rewind and runner handoff until a native implementation exists.
- Offer configured daemon hosts in the existing new-session flow. Thread creation is explicit. Read file links through that daemon's filesystem API and the existing viewer, with bounded reads scoped to the thread workspace or configured roots.
- Treat native JSON-RPC requests separately from Desktop asynchronous questions embedded in assistant messages. Verify the Desktop answer envelope and native send path before wiring the latter. Never present an answer as accepted merely because a local form disappeared.

## Delivery split

The backend worker owns hub transport, routes, lifecycle and catalog filtering. The frontend worker owns adapters for the existing HAPI list and chat components. The protocol worker owns existing creation/file flows and verifies installed Desktop/native request behavior. A separate worker reviews integration boundaries. The parent integrates and validates in an isolated WSL staging copy before updating production. Workers use GPT-6.1 Sol as requested.

## Acceptance

1. M1 opens at its actual latest response with original timestamps; native older cursors remain continuous across multiple pages.
2. Reading, paging and reconnecting create no HAPI message rows or new native threads. Native idle/running status remains authoritative.
3. Only visible thread subscriptions are retained; closing clients releases them. Memory and queued events are bounded independently of history size.
4. Controls are available independently of pending history reads. Settings are confirmed from the daemon, with errors visible.
5. Desktop async answers use the verified Desktop envelope and same native thread; native request replies preserve request identity and resolution semantics.
6. Ordinary project chats appear automatically when membership is known. Unknown membership uses the requested quiet manual fallback. Background catalogs are collapsed and paginated.
7. Existing provider/authentication behavior continues to pass its checks. Add focused regression coverage for these boundaries rather than duplicating implementation details in tests.
8. Old M1 URLs resolve to the same native thread, the original HAPI chat components render its latest history, and no action can re-enter the legacy importer or executor. Remove obsolete HAPI message/state copies after backup and identity verification, retaining only URL aliases.

## Verification plan

Use WSL's existing Bun/Node dependencies, focused package tests during implementation, then the repository-required cross-package typecheck/test run. Validate real native read-only operations against the existing daemon. Exercise mutations with controlled disposable fixtures or an isolated daemon, never by sending test prompts to the user's project chats. Browser checks cover the original HAPI routes, latest/older pages, menus, file links, creation, quoting and question forms. Record any difference between simulated coverage and actual cross-client validation.
