# Remote provider command capabilities

The remote runner resolves `/compact`, `/approve`, `/recap`, and `/usage` before ordinary model input. Exact command names with whitespace or end-of-input are recognized; filenames such as `/compact.md` are ordinary input. Project commands, installed command templates, discovered skills, and provider-reported executable commands retain ownership of their names.

| Provider | `/compact` | `/recap` | `/usage` | `/approve` |
| --- | --- | --- | --- | --- |
| Claude | Existing native SDK slash-command path; optional native instructions preserved | Native `--resume --fork-session` side query, with no tools, hooks, or session persistence | Latest usage already reported by the main conversation | No native one-time rejected-action retry contract is integrated |
| DSH | Public native command registry through the HAPI ACP adapter extension; native argument grammar is preserved | Not provided by the installed native registry | Latest reported usage/context facts | Not provided by the installed native registry |
| AGY | No safe headless compaction operation is integrated | No isolated recap operation is integrated | Latest usage reported in streamed step/result envelopes | No equivalent headless retry operation is integrated |
| Pi | Existing native compact RPC, including custom instructions | Not integrated; discovered extension commands keep precedence | Latest reported session usage; `/session` retains its existing native statistics RPC | Not integrated; discovered extension commands keep precedence |
| OpenCode | Existing native session summarization API | Not integrated | Latest reported session usage | Not integrated |
| Cursor / Grok | Sent through the existing ACP command path only when the current ACP session advertises it | Only a provider-reported executable command can own this name | An advertised native command takes precedence; otherwise latest reported session usage | Only a provider-reported executable command can own this name; no permission-policy alias is invented |
| Copilot / Kimi | No new compaction operation is claimed | Not integrated | Latest reported session usage | Not integrated |

An unavailable built-in receives a local explanation and is not sent to the model as a chat prompt. `/approve` does not toggle a permission mode or approve a different pending request. A user-defined command with that name retains its existing provider behavior.

The local `/usage` report is a snapshot of the most recent usage facts actually received in this running HAPI process. It is not an account limit, subscription quota, or reconstructed session total. Before a report arrives it says that no usage is available. ACP context-only updates do not become fictitious zero-token bills. Claude synthetic API errors and subagent messages do not replace the main conversation snapshot.

Claude `/recap` requires an existing native conversation and accepts no arguments or attachments. The independent query reads a native fork, disables built-in tools and MCP servers, disables hooks and slash expansion, and uses `--no-session-persistence`. Its temporary native session ID is not adopted by HAPI. A timeout or session shutdown cancels the query; the main conversation's thinking state, model preference, and permission settings are not changed. This operation uses a model request and may incur provider usage.

DSH command execution uses public `ctx.commands.list` / `ctx.commands.execute`, exact owned Agent identity, an idle session, and the original command's grammar. The ACP readable transport remains available during execution so `session/cancel` can abort the command. The default installed DSH registry exposes `compact`, `feedback`, `goal`, `permission`, and `plan`. A custom ACP server that does not advertise the HAPI command extension receives an explicit unsupported result for `/compact`. Attachments are not admitted for this adapter's native `/compact` path.

Verification used the installed DSH 0.2.0-rc.2 with a deterministic local LLM adapter: native `/compact` executed with its own command ID and returned “No compactable history yet.” without another `session/prompt`. The installed Claude CLI was tested against a local deterministic HTTP provider: the recap used a different session ID, offered no tools, and left every persisted source-conversation JSONL file and its hash unchanged. No external model or user conversation was used in those probes. Cursor/Grok executable command availability is determined from the running ACP session; their binaries were not exercised in the local probes.
