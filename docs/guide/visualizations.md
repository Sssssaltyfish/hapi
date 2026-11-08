# Inline Visualizations

HAPI renders interactive HTML fragments in chat. Any agent can produce one by writing the file and emitting the Codex Desktop Visualize reference in an assistant response.

## Use a visualization

Ask for an inline visualization when you want to manipulate data, compare scenarios, or inspect a process. The agent writes an HTML fragment and returns a reference like this on its own line.

```text
visualize{"path":"/absolute/workspace/forecast.html","title":"Forecast"}
```

Use the absolute path on the machine running the agent. JSON strings with Windows backslashes need escaping, for example `"C:\\work\\forecast.html"`. Keep the reference in plain response text so HAPI can turn it into a widget. Add `"mode":"wide"` when the layout needs more room. Use the widget's expand control to open a larger view.

Write a regular `.html` file of at most 1 MiB inside the current session workspace. The runner needs read access when HAPI resolves the reference. A path elsewhere on the runner, including an absolute path printed by a different machine, can be unavailable. If the agent works on a remote runner, write the file there rather than on the device displaying the chat.

Widgets follow the HAPI theme. Widgets that use the state API can restore a snapshot in the same browser when you reopen the conversation. A widget's follow-up button can ask for confirmation and append text to the composer. Review or edit that draft and send it yourself.

## Share the authoring skill

HAPI bundles `skills/hapi-visualize/SKILL.md` with the CLI. Compiled CLIs maintain one copy at `$HAPI_HOME/bundled-skills/hapi-visualize/SKILL.md` (`~/.hapi/bundled-skills/hapi-visualize/SKILL.md` by default). The common HAPI skill catalog includes it after project and user skills. CLI startup refreshes the bundled copy when its contents change, including upgrades that keep the same package version.

Native agents also need to discover that file through their own skill system. Link their `hapi-visualize` skill directory to the shared HAPI directory **on the machine and under the account running the agent**. This includes Claude's native command catalog and Codex Native, which reads skills directly from its daemon. Use a directory symlink on Linux/macOS or a directory junction on Windows. Start HAPI once to create the shared target. A project link applies to that workspace; a user link is available in other workspaces for that provider.

| Agent | Project skill directory | User skill directory |
| --- | --- | --- |
| Codex | `.agents/skills/` | `~/.agents/skills/` or `$CODEX_HOME/skills/`, usually `~/.codex/skills/` |
| Claude Code | `.claude/skills/` | `$CLAUDE_CONFIG_DIR/skills/`, usually `~/.claude/skills/` |
| Antigravity (`agy`) | `.agents/skills/` | `~/.gemini/config/skills/` |
| DeepSeek Harness (`dsh`) | `.agents/skills/` or `.dsh/skills/` | `$DSH_HOME/skills/`, usually `~/.dsh/skills/` |

HAPI does not change provider configuration automatically. Codex and DeepSeek Harness can share one user link at `~/.agents/skills/hapi-visualize`; Claude uses its own skills directory. Antigravity can reference the same shared directory explicitly in `~/.gemini/config/skills.json`:

```json
{
  "entries": [
    {
      "path": "/absolute/path/to/hapi-home/bundled-skills",
      "include_only": ["hapi-visualize"]
    }
  ]
}
```

Merge this entry with an existing configuration. HAPI's directory fallback does not interpret Antigravity's custom manifest rules; Antigravity itself resolves them. In source checkouts, HAPI reads the repository's `skills` directory directly, so use that as the link target instead of the compiled path.

Ask for `hapi-visualize` by name after installation. Runner sessions with a catalog captured at startup need a fresh agent session to expose newly installed skills. A custom ACP server uses its own skill discovery. If a provider cannot find the skill, include the authoring instructions directly in the request.

Codex Desktop users who already have the Visualize skill enabled can use it directly. HAPI reads Native fragments through the connected daemon. Files outside its workspace must be permitted by that endpoint's `allowedRoots` or `fileAccess` configuration. For ordinary runner sessions, save the fragment inside the session workspace.

## Test on any HAPI runner

Send this same prompt to each provider you want to verify. It includes the contract so it also works in a session where you have not installed the skill.

```text
Create an inline HAPI widget with a slider from 0 to 100, starting at 25.
Update the visible value as I drag. Use CSS theme variables for the text and
background. Restore the slider from window.openai.widgetState and from the
openai:set_globals event, and save it on change with
window.openai.setWidgetState({ modelContent: { value }, privateContent: null }).
Add a button labeled “Ask about this value” that only on click calls
window.openai.sendFollowUpMessage({ prompt: `Explain the value ${value}.`,
title: 'Ask about this value' }).
Write a self-contained HTML fragment named hapi-widget-smoke.html inside this
session's workspace, with inline CSS and JavaScript and no network requests.
End your response with the literal marker below on its own line outside code.
Replace ABSOLUTE_PATH with the JSON-escaped path to the file.
visualize{"path":"ABSOLUTE_PATH","title":"Slider check","mode":"wide"}
```

For a Codex Desktop conversation with Visualize enabled, use this shorter prompt.

```text
Use Visualize to show a themed slider from 0 to 100 with a live value, saved
widget state, and an “Ask about this value” follow-up button. Save the fragment
inside this workspace and include the Visualize reference in your final reply.
```

Open the response in HAPI and check the widget there.

1. Drag the slider and confirm the visible number changes. Expand the widget and check that the control still works.
2. Switch between the light and dark HAPI themes. Confirm the text, background, and control are readable in both.
3. Set a value other than 25, leave the conversation, and reopen it in the same browser. Confirm the chosen value is restored.
4. Click **Ask about this value** and cancel once. Confirm the composer is untouched. Click again and confirm. Verify that the draft contains the selected number, any existing draft text is preserved, and the chat has received no new message.
