# Codex native questions and requests

Verified 2026-10-29 against the installed Desktop bundles and the native WSL daemon at `unix:///home/igna/.codex/app-server-control/app-server-control.sock`. Both the installed CLI and daemon initialize response identified `0.165.0-alpha.1.2`; an earlier audit's `0.164.0-alpha.11.1` is no longer the running version.

## Async questions

Desktop represents `request_user_input_async` as questions attached to an `agentMessage` item:

```ts
{ type: 'agentMessage', id: string, questions: Array<{ title: string; options?: string[] }> }
```

The exact question identifier is `JSON.stringify(['request_user_input_async', item.id, questionIndex])`. Preserve the opaque source item ID and zero-based question index. A reply is ordinary user input containing the following exact wrapper, with JSON serialized by a JSON library:

```text
<send_user_message_question_reply>
[{"questionItemId":"[\"request_user_input_async\",\"ITEM_ID\",0]","question":"Original question title","answer":"User answer"}]
</send_user_message_question_reply>
```

Installed Desktop accepts an array with at least one reply, and also parses a single reply object for compatibility. Its pending question calculation collects question IDs from `agentMessage.questions` and subtracts IDs found in wrapped user messages or `steeringUserMessage` items whose status is `accepted`. A pending or rejected steering item does not resolve the question.

HAPI renders these user-message envelopes as question/answer pairs. Parsing affects presentation and copying only: the original wrapped text remains the native input, history record, and retry payload. Invalid envelopes and quoted examples remain ordinary text.

For an active turn, the supported app-server input primitive is:

```json
{"method":"turn/steer","id":42,"params":{"threadId":"THREAD_ID","expectedTurnId":"ACTIVE_TURN_ID","clientUserMessageId":"STABLE_CLIENT_UUID","input":[{"type":"text","text":"WRAPPED_REPLY"}]}}
```

`expectedTurnId` is required and fails if the active turn changed or ended. Preserve that race check. The wrapper semantics are verified from installed Desktop; a live async answer has deliberately not been sent during this investigation. End-to-end acceptance of a real async question remains a targeted smoke test. When the originating turn has completed, any reply starts follow-up work through the normal explicit message flow; do not silently transform a failed active-turn answer into a new turn.

Bundle evidence: `webview/assets/app-initial-db76c3384587.js`, functions `ZJt` (ID), `QJt` (wrapper), `Jw` (parser), `rYt` (question projection), `E3t`/`A3t` (pending and accepted reply rules). The main process bundle duplicates these rules as `bSe`, `xSe`, `SSe`, and `iy`.

## Blocking server requests

`item/tool/requestUserInput`, command/file/permission approvals, MCP elicitations, and dynamic tool calls are server-initiated JSON-RPC requests. A client that receives a request answers using its original JSON-RPC `id` and the method-specific result shape. `serverRequest/resolved` is a notification confirming completion or cancellation; it is not an API for retrieving or answering a request.

The generated experimental `ClientRequest.json` contains neither `serverRequest/list` nor `serverRequest/respond`. A read-only live call to `serverRequest/list` returned `-32600` with an unknown method variant. Do not invent these routes.

The public app-server implementation supplies the pending snapshot through **request replay after resume**, rather than a list route. In pinned commit `9cc14e79882ff8885cd5d33b4adadae014045aef`, [thread lifecycle lines 1230–1259](https://github.com/openai/codex/blob/9cc14e79882ff8885cd5d33b4adadae014045aef/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L1230-L1259) sends the resume response, then invokes `replay_requests_to_connection_for_thread`. [Outgoing request routing lines 513–548](https://github.com/openai/codex/blob/9cc14e79882ff8885cd5d33b4adadae014045aef/codex-rs/app-server/src/outgoing_message.rs#L513-L548) sends each pending request with its original ID to the attaching connection.

Install the incoming request handler before sending resume. Keep it active after the response resolves: replay follows that response. Preserve IDs as strings or numbers, retain the original method and params, deduplicate replay by ID, and send `{id: originalId, result: methodSpecificResponse}` over the same transport. Remove UI prompts on `serverRequest/resolved`. [Callback removal lines 645–689](https://github.com/openai/codex/blob/9cc14e79882ff8885cd5d33b4adadae014045aef/codex-rs/app-server/src/outgoing_message.rs#L645-L689) makes the first accepted response consume the shared callback. A competing later reply cannot resolve it again; sending a response alone does not provide an application-level acknowledgement.

This applies to ordinary blocking tool input. User verification ceremonies are tied to one connection and excluded from replay. The newer public source also gates the special `HumanCommand` approval variant by eligible connection; this gate does not cover ordinary `ToolRequestUserInput`. These restrictions should remain method-specific. The source demonstrates the intended multi-client route; a real pending request replay on the installed daemon has not been empirically exercised because the probe did not generate or answer model work. Async questions remain recoverable from history independently.

## Bounded attachment and history

Use `thread/resume` with `{threadId, excludeTurns:true}` to attach and subscribe while excluding historical turns. Do not pass model, approval, sandbox, workspace, or instruction overrides when attaching an existing Desktop chat. This can load an unloaded thread and start its MCP integrations, but it sends no user input or model request.

The live M1 probe returned the same ID, `historyMode: paginated`, zero turns, and 4,034 response bytes. Initial load took 5.35 seconds and changed runtime status from `notLoaded` to `idle`. A subsequent `thread/turns/list` with `limit:1`, `sortDirection:'desc'`, `itemsView:'summary'` returned 36,686 bytes: even a single summary page can contain substantial text, so retain item pagination.

`thread/items/list` accepts `{threadId, turnId?, limit?, sortDirection?, cursor?}`. The cursor is either an opaque string or `{type:'item',itemId}`; an item anchor requires `turnId` and is exclusive. Continue pagination with returned opaque cursors. `thread/resume` also supports optional `initialTurnsPage` and returns backwards cursors. Release subscriptions with `thread/unsubscribe` when a chat no longer needs streaming.

## Native message queue

The installed schema defines:

```ts
// All add fields are required.
thread/queue/add({ threadId, clientUserMessageId, input })
  => { queuedSubmission: { id, clientUserMessageId, input } }
thread/queue/start({ threadId, queuedSubmissionId?: string | null })
  => { turn }
```

Use a stable client message ID and preserve the returned submission ID. Do not claim retry deduplication from the field name alone: the schema provides no explicit idempotency guarantee. Queue/start is an execution action and was not exercised in the read-only probe.

## Evidence and reproduction

The generated schema and the standalone read-only probe are under deployment diagnostics `diagnostics-native-20261029/schema` and `request-probe.cjs`, outside the source tree. Generate a fresh schema with `codex app-server generate-json-schema --experimental --out DIR`. Run the probe under WSL with Node and the existing `ws` dependency; it initializes a separate client, probes the unsupported list route, reads metadata, attaches without history, and fetches one turn summary. It never responds to incoming requests or sends input.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes active-turn steering, server-initiated request responses, and resolved notifications. Installed version-specific schemas and bundle evidence supply the additional Desktop async wrapper and pagination details above.

## File and image inputs

Read-only investigation on 2026-10-30 confirmed the installed CLI remains `0.165.0-alpha.1.2`. Its generated experimental `UserInput` schema includes `text`, `image`, `localImage`, `audio`, `localAudio`, `skill`, and `mention`; it has no generic `file` input. `image` accepts a URL or an existing image `fileId`, while `localImage` accepts a path on the daemon's execution host. An image `fileId` is not a generic document upload interface.

App-server does expose byte transfer: `fs/writeFile({path, dataBase64})` writes base64-decoded contents to an absolute path on its host, and `fs/createDirectory`, `fs/copy`, `fs/readFile`, and `fs/remove` provide the accompanying file operations. File transfer therefore does not require invoking the agent's terminal. Ordinary documents can be staged on the execution host and referenced by path in text input; the agent's available tools then determine how their contents are read or parsed.

The installed Desktop main bundle (`main-CP9z2iYn.js`, line 521, `vCe.uploadLocalFiles`) implements this for remote hosts: create a directory under the remote Codex home `attachments/<UUID>`, read the client file, write it through `fs/writeFile`, and replace its attachment path with the remote path. Its SSH host adapter (line 624, `uPe`/`sPe`) uses a 10 MiB direct-transfer threshold when SFTP is allowed, then transfers larger files using SFTP `put`. This is Desktop's attachment transport policy, not a universal app-server file-size limit.

For pictures, Desktop's input builder (line 540, `mx`/`CDe`) uses `localImage` for an accessible local path and `image.url` for a data URL when targeting a remote host. The [official upstream TUI image preparation implementation](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/image_submission.rs#L123-L163) likewise snapshots local images into inline image URLs before remote submission. That upstream source is supporting evidence for current TUI behavior, rather than a claim that its revision matches the installed binary. The official mobile application's private upload protocol was not verified in this investigation.

HAPI's existing runner attachment path uploads base64 through the Hub to the runner, stores the file on that runner's host, and prefixes attachment paths into the Codex prompt. Native attachments now reuse the existing picker and upload through `fs/writeFile` into a namespace/endpoint/thread-scoped directory under the daemon's Codex home. Images use `localImage`; ordinary files retain their daemon-local paths in text input. A disposable native model run verified a supplied text marker and red PNG. Native-specific frame limits were removed; the existing HTTP limit and daemon errors remain authoritative.

The installed `fs/writeFile` schema supplies neither append/offset/chunk fields nor a stream handle. The upstream filesystem processor also decodes the complete base64 value before writing. Splitting the browser-to-Hub request alone would still allocate the complete value at the daemon boundary. End-to-end streaming would require a new daemon method or a separate transfer channel such as Desktop's SFTP implementation; it is not a small bridge-only change.

## Composer mentions

Live reads confirmed `fs/readDirectory`, `fuzzyFileSearch`, `skills/list`, `plugin/list` and `app/list`. Bare `@` lists the workspace directory; typed queries use fuzzy search. Plugin suggestions require installed and enabled entries. App suggestions require accessible entries that are not disabled; unsupported or timed-out discovery contributes no fabricated entries. First-query plugin and app discovery have independent bounded connections and subsequent queries share a short-lived cache.

`UserInput.mention` accepts app/plugin references, while `UserInput.skill` identifies a skill path. In a disposable live model check, sending filesystem paths only as typed mentions caused the model to ask for the missing paths despite correct queue acknowledgement. Filesystem suggestions therefore preserve their quoted text in the message. The parser retains the existing escaped-quote/backslash grammar, and only app/plugin URI references become typed mentions.

## Selected response annotations

Read-only inspection of the same installed Desktop bundles on 2026-10-31 verified its Add to chat response format. The `app-initial-db76c3384587.js` input builder `man` emits a `# Response annotations:` prefix, an instruction paragraph (`Kan`), and a JSON array enclosed in `<response-annotations>` / `</response-annotations>` tags. Its `mGn` schema accepts `{text: string, annotation?: string, source?: {messageId: string, startOffset: number, endOffset: number}}`. Source is optional; nonnegative integer offsets require `endOffset > startOffset`. These records are serialized within ordinary text input, rather than a new app-server input variant. The shared bundle's `Cv` parser recognizes the envelope.

Desktop `Wbs` obtains `source.messageId` from `data-response-annotation-target`. Its conversation projection assigns the original `agentMessage.id` to that attribute. The `jbs` helper computes offsets using `Range.toString().length`, counting rendered DOM text in UTF-16 code units; `Wbs` subtracts the selected Markdown text container's starting offset. These are rendered-text offsets, not indices into raw Markdown or HAPI's synthetic message IDs.

HAPI's native projection preserves the actual source item ID explicitly. Selecting within one uniquely matched native text part attaches that ID and offsets relative to the rendered part; selections crossing parts or ambiguous repeated text omit source. Runner Codex uses the same valid annotation envelope without invented source IDs. Each quote card exposes an editable note in Desktop's `annotation` field. The full serialized text, including notes and source, remains the single composer draft, send, queue, and failure-recovery payload; the input and sent-message bubbles project the annotation cards separately from the editable message body. [Provider input evidence and text fallbacks](./response-quotes.md) document the other integrations without assuming their own desktop UIs lack quoting.

This change was verified against the installed schema and bundle functions, with local rendering/serialization tests. It did not submit model input or claim a live native response-annotation acceptance test.
