# Codex Desktop / HAPI audit — 2026-10-29

Status: diagnosis and limited source repairs; **not a production rollout**. The deployed replay architecture still needs replacement before restarting automatic discovery.

## Decision

For a phone browser controlling the same Codex daemon and native threads as Desktop, continuing to patch HAPI's current imported-transcript model is not the preferred long-term solution. Use a native app-server web adapter with native history cursors and runtime state as its source of truth. HAPI's authentication and some presentation components remain reusable. Replacing this core is substantially more work than fixing ten independent UI bugs.

No inspected off-the-shelf alternative is a verified drop-in replacement for this Windows Desktop + WSL setup:

| Candidate | Evidence | Fit |
| --- | --- | --- |
| Current HAPI | Its documented shared sessions use an HAPI-owned app-server. This installation adds external-daemon attachment. The shared root implementation eagerly loads root and descendant history, then projects it into HAPI's message database. | Useful UI/authentication, unsuitable current synchronization core for large native histories. |
| nathan-chappell/codex_web_ui | Revision `79be149c427040d7fbb94246d841f705ab53ce9e` supports an existing Unix socket. Its client still uses `thread/read(includeTurns: true)`; no native turns/items pagination was found. README calls it experimental. | Closest topology; implementation reference, not ready for this paginated M1 thread. |
| Codex-Workbench | Revision `479475ed46383ca1864f943af174622c26643d25` spawns an app-server; error fallback can call `codex exec resume`. The turns-list path reads one page without following its cursor. Desktop automation uses macOS APIs. | Does not establish same-daemon Windows/WSL operation. |
| CodexMonitor | Tauri desktop frontend, app-server per workspace; mobile remote work is not a browser drop-in for the existing Desktop daemon. | Different deployment model. |

Sources: [HAPI shared sessions](https://hapi.run/docs/guide/codex-shared-sessions), [official app-server documentation](https://learn.chatgpt.com/docs/app-server), [codex_web_ui](https://github.com/nathan-chappell/codex_web_ui), [Codex-Workbench](https://github.com/caiqiangting321-hub/Codex-Workbench), [CodexMonitor](https://github.com/Dimillian/CodexMonitor).

## Evidence from this installation

- Baseline HAPI revision: `85ccab1ac673bb848a3ca80e448b919db1cfccef` (v0.31.3), with the local patches retained in separate commits.
- Desktop package inspected: `26.1023.6621.0`; WSL Codex: `0.164.0-alpha.11.1`.
- Before the Windows reboot, kernel records show WSL anonymous memory near 45.9 GiB, free memory about 217 MiB, and 12 GiB of swap exhausted. HAPI service accounting showed an 8.2 GB hub peak, 3.4 GB runner peak, discovery memory growth, and stop timeouts. These are strong indications of HAPI-related amplification, not proof that HAPI alone owned every allocated page or that a specific heap leak was identified.
- HAPI database: about 544 MB. M1 alone: 240,946 stored messages. Of its latest 200 records, 198 were descendant `agent-run-trace` events. Their storage times fall in the import interval, not the native conversation interval.
- Native read-only probes found M1 **idle**, with a completed latest turn. Metadata took about 85 ms; metadata plus latest-turn summary about 94 ms. A separate five-item descending history query took about 77 ms and provided `startedAtMs` / `completedAtMs`.
- M1 has historical `inProgress` turns left in storage. Searching for any such turn is not a valid test for current execution.
- Read-only replay of the existing HAPI DB through its existing built frontend reproduced the stopped-session banner together with Running agent cards and no latest root response. Diagnostic server memory peaked near 101 MiB. This was a localhost-only, read-only replay with stubbed connection events; it does not prove a production SSE transport fault or production post-fix performance. The diagnostic server and tab were closed.
- The existing native UUID is the same one mapped by HAPI. The observed status discrepancy is explained by stale projection; no evidence was found that a second native M1 thread was created.

## Ten reported issues

| # | Finding | Repair / remaining work |
| --- | --- | --- |
| 1 Performance | `SharedCodexRoot.readThread` walks all turns, `refreshChildren` walks descendant history, reconnect replays it, discovery starts a wrapper per imported root. The import picker also scans complete JSONL files synchronously. | Replace full replay with native paging and bounded subscriptions/cache. Resource containment is active; no post-fix full-load performance claim. |
| 2 Membership | Desktop combines explicit assignments, host, projectless/deleted exclusions, cwd/canonical path, worktree repository identity and root hints. Explicit assignment alone is incomplete. | New resolver removes the supplemental ID file, uses default interactive `thread/list` filtering and Git identity. Real data resolves QDP's four requested chats plus three `igna` chats. Cross-host aliases and ambiguous multiple clones remain a documented parity boundary. |
| 3 Import picker | Background exec records are mixed with interactive records; the legacy JSONL scanner currently excludes subagents altogether. | Present records and background-only cwd options are sorted last, and background records no longer receive the “original” badge. A real optional child section needs a paginated native catalog; it is not implemented by enabling an unbounded JSONL scan. |
| 4 Connection banner | “后台恢复中” is the `visibility-recovery` label in `useSSE`: stale connection recovery after a hidden browser tab becomes visible. It does not establish that a backend restarted. | Overload and reconnect replay can worsen interruptions. The precise cause of each past disconnect is unproven. Future validation must capture browser visibility, SSE state, hub event-loop delay, and native transport state separately. |
| 5 Missing latest transcript | Child replay was appended after root history with import-time timestamps, so it occupies the HAPI tail. Child history also omitted completion lifecycle events. | Completion projection and timestamp transport repaired in source. Latest-first native pagination and old cached-history migration are still required. |
| 6 Reasoning effort | Model catalog and effort callbacks are gated by HAPI session active state. Controls are registered only after root and all child history finish binding. Offline replay exposes permission controls but no effort selector. | Need separate bridge availability from native turn activity and fast attachment before history. Native `thread/settings/update` exists; a live cross-client settings roundtrip was not performed in this audit. |
| 7 Quote / questions | Selected-text quoting was absent. The request renderer expects `request_user_input` with `id/question` and object options; Desktop async requests have a different shape and may be Desktop-owned tool state. | Selected-text quoting added to the draft. Native questions and Desktop async questions require distinct adapters and resolution ownership; full Desktop async reply parity is unproven. |
| 8 False running | Root chose any old inProgress turn; descendant history omitted terminal lifecycle; unknown agent status was mapped to running. | Root now considers only the latest turn plus native runtime status. Historical child completion is emitted, shutdown/errored terminal states are handled. Existing DB rows are not rewritten by source edits. |
| 9 Scroll / pagination | The frontend does initially load a local tail and prepend earlier pages. The local chronology is wrong, and ingestion is eager. HAPI position cursors and native history cursors differ. | Native paging must be connected end to end. Limiting ingestion to the latest page alone would silently lose older history or introduce reconnect gaps. |
| 10 Time | Shared Codex sends no original timestamps, so storage defaults to import time; messages-consumed also used wall-clock time at import. | Timestamp transport and native item-page projection added; legacy replay can use turn-level timestamps. Exact operation times require the native items endpoint and reindexing cached imported rows. Old production data remains unchanged. |

## Project membership and provenance

The inspected Desktop UI defaults to native `thread/list` with `sourceKinds: []`, `useStateDbOnly: true` and paginated results. It rejects ephemeral/ambient suggestion entries. In this installation that yields twelve interactive candidates, which reduce to seven project members through desktop state and Git identity.

The new resolver reads the Windows desktop state, not a maintained thread-ID allowlist. It applies valid same-host explicit assignments first, then projectless/deleted exclusions, exact or canonical cwd, and linked-worktree repository-relative matching. Git probes are cached and bounded. Two new worktrees therefore join their project without a manually added session ID. Tests also reject arbitrary validation-run descendants and exec/subagent records.

This is a tested implementation of the rules needed by the current host. It is not a public, versioned Desktop project-membership API. Host-alias migrations, multiple equivalent clones and future Desktop state-format changes need additional parity tests. Ambiguous ownership currently remains unimported instead of guessing.

WSL `source` and parent markers distinguish exec/subagents reasonably well. They do **not** prove human initiation. M1 itself has `threadSource: agent_created_thread` while being a valid Desktop project chat. Do not use this field as a universal rejection rule.

## Required native adapter behavior

1. One connection to the existing daemon; viewing a thread must never fork, run `codex exec resume`, or silently spawn a replacement app-server.
2. Enumerate native metadata only for the sidebar; retain native thread identity and Desktop title/preview.
3. For a large conversation, read a bounded newest item page, then follow native older cursors on user demand. Preserve original start/completion times, deterministic item order, tool call identity and user-message acknowledgement. Do not mix child trace chronology into the root tail.
4. Keep bridge connectivity, native thread execution state and individual child execution state distinct. Reconnect must reconcile current state without replaying all stored history.
5. Send native settings mutations and confirm their actual settings notification. Show failures to the operator. Preserve pending input across reconnect without duplicate submission.
6. Route native request IDs and first-winner resolution correctly. Display unsupported Desktop-owned interactions explicitly; do not render a form whose answer cannot reach the owning tool.
7. Bound memory and subscription count independently of historical transcript size. Open child history only when requested.

Acceptance evidence must include M1 opening at its actual latest final response; older-page continuity across refresh and reconnect; correct timestamps; zero new native threads on view; agreement with Desktop idle/running state; an effort update visible in both clients; answering a real native question once; and a separately tested Desktop async-question path or an explicit unsupported result.

## Operations and validation

HAPI hub, runner and discovery remain stopped and their automatic startup is disabled. Native Codex was not restarted for this audit. No model prompts were sent to the referenced chats. No native histories were deleted. Production imported rows have not been migrated or cleared.

The local branch `local/codex-remote-repair` retains previous deployment patches and these independent repairs. Nothing was pushed. WSL test source copies contain the same changes, but the deployed compiled wrapper and built frontend have not been replaced. Source backups are in the task deployment directory on WSL.

Full verification: 8,616 tests passed and 11 existing tests were skipped (CLI 3,246 passed / 11 skipped; hub 1,418; web 3,505; shared 329; relay 118). All-package typecheck and fixture generation passed. The web test command used `NODE_OPTIONS=--no-experimental-webstorage` on Node 26 to avoid its native Storage conflicting with jsdom. The new composer subscriber required updating the mobile-scroll test fixture; the final full web suite passed after that correction.

A separate read-only prototype fetched the newest 50 native history items and projected 17 HAPI messages in about 96 ms. The newly built frontend displayed the latest final response at its original `2026-10-26T12:06:21.451Z` time (20:06 Asia/Shanghai). Browser interaction confirmed that selecting response text exposes the quote button and inserts a Markdown quote into the draft without sending. Browser screenshot capture timed out, so this UI result is verified by the live DOM and actual clicks, not a captured screenshot. This prototype serves only one bounded native page; it does not establish full older-cursor continuity, live settings changes or request ownership. Its SSE responses were diagnostic stubs. It is not deployed or a completed replacement adapter.

The bounded native-page preview peaked at 84,639,744 bytes of service memory and was stopped after verification; its browser tab was closed. Generated shared fixtures have no tracked diff. `git diff --check` passed.

Local implementation commits:

- `5ec8d1e`, `1f7537e`, `cd01964`: preserve the existing passkey, external-daemon/title and discovery deployment patches as reviewable baselines.
- `6f3d6ba`: Desktop project/worktree membership without supplemental thread IDs.
- `0718db9`: native history time transport, item-page projection and terminal execution state.
- `9146f76`: selected-text quoting into the current draft.
- `c50ca64`: background history entries after interactive chats.

Local raw diagnostic scripts and observations are in `../diagnostics-20261029/`. Extracted proprietary Desktop assets and authentication data are not included in Git.

## Native bridge integration review — 2026-10-30

This supersedes the initial audit's deployment status above. Native Codex uses the existing HAPI list, chat, composer, file viewer and creation form. The upstream comparison target is v0.31.3 (`85ccab1`), the deployed base; this work does not upgrade upstream. UI creation choices distinguish runner machines from native endpoints while retaining the Codex wire flavor. Explicit API adapter operations replace argument-based routing guesses. Agent labels reuse display preferences, and model/effort shortcuts remain visible on phones.

Daemon-backed attachments now support images, files and attachment-only input. The hub keeps no attachment registry or native conversation state. The custom Native file-viewer and WebSocket payload caps were removed; the upstream HTTP body limit remains. Native files still transfer as complete payloads. A disposable model run read the supplied text marker and identified the supplied red PNG; its completed conversation was archived. Separate phone UI checks covered creation, model/effort menus, an applied High setting and an uploaded draft removed before cleanup.

Read-only review found two pagination defects, both corrected: stale older/background responses could override a Return latest operation, and aggregate truncation could expose a cursor that skipped unseen sessions. Focused regressions cover those races and 50/50/20 endpoint pagination. No additional authoritative history cache or namespace bypass was found in the reviewed bridge paths.

The combined source passed all-package typecheck and existing suites: CLI 3,246 passed / 11 skipped; hub 1,438 passed / 3 skipped; web 3,528 passed; shared 329 passed; relay 118 passed. Fixture generation produced no content drift after normalizing Windows line endings; the production web build passed. Only focused regressions were added. Native source formatting was checked against TypeScript ASTs before and after formatting.

The shared Seia authentication adapter is a local deployment customization. Keep it, the earlier local Passkey baseline and deployment configuration separate from reusable Native provider commits. It does not belong in the proposed upstream Native feature. Authentication changes were delivered by the separately authorized Editor task, reviewed independently, and integrated by the HAPI owner. Runtime configuration and secrets stay outside Git.

## Native devices and mentions follow-up — 2026-10-30

The creation selector now retains runner context while Native is selected, including asynchronous discovery and saved preferences. Native machines reuse the original Machine field and device-name editor. Connection metadata is persisted by the existing Hub settings store; stable endpoint IDs remain independent of display names. Initialize supplies OS and connection facts. Namespace checks and credential scrubbing apply to listing, status, rename and errors. A shared five-second catalog deadline closes operation-owned connections; all configured endpoints start within the existing sixteen-endpoint configuration bound, so several unresponsive endpoints cannot starve a later healthy one. This adds no conversation database state.

Composer suggestions reuse HAPI's existing UI for native workspace files/folders, installed enabled plugins, accessible apps and enabled skills. A real first model run showed that filesystem paths supplied only as typed mentions were not visible to the model. The corrected path keeps filesystem references in quoted text, reserving typed mentions for app/plugin URIs and typed skills for leading skill input. A second independent run read a marker from a filename containing Chinese characters, spaces and quotes, and listed the referenced folder. Both completed scratch conversations were archived. HAPI remained at seven URL aliases and zero stored messages. Plugin, app and skill discovery were verified with actual daemon responses; no external plugin operation was invoked as a test.

Phone-width browser checks verified switching from Native to Claude and original Codex, persisted machine rename and addition in an isolated config, real Linux/address/status display, file/folder/plugin/skill suggestions and quoted insertion. No input was submitted to M1. Existing live history and updates remained visible. The Native placeholder and introductory hint now describe its supported references instead of promising session handoff.

Large-file streaming remains a protocol boundary: `fs/writeFile` accepts one complete base64 value with no chunk/append/offset API. HTTP-only chunking would not remove the complete allocation at the daemon boundary. The existing attachment path remains usable; a separate transfer protocol was not added.

The local Seia adapter now keeps HAPI's original Passkey form and forwards its ceremony to the shared verifier. Editor independently keeps its own form. Shared credentials, session exchange, revocation checks and exact-origin validation remain centralized; there is no central-page redirect in either application's new login flow.
