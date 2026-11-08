---
name: hapi-visualize
description: Create an interactive visualization in a HAPI conversation when the user needs to explore data, manipulate controls, or see a process change inline. Use the normal project workflow for requests to build or edit websites, components, and standalone files.
---

# HAPI Visualize

Write a self-contained `.html` fragment in a writable directory inside the current session workspace. Use literal HTML with a unique root ID and keep the file at or below 1 MiB. Omit `<!doctype>`, `<html>`, `<head>`, and `<body>`. Keep CSS and JavaScript inline and scope selectors and DOM queries to the root. Use accessible labels and keep the widget compact enough for a chat column.

Use host CSS variables such as `--background`, `--foreground`, `--muted`, `--border`, and `--primary` for light and dark themes. Native inputs and basic utilities such as `.btn` and `.btn-primary` can be used for controls. If drawing to canvas, read resolved colors and redraw when the theme changes.

Keep data and interactions local. External static dependencies may use `cdnjs.cloudflare.com`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `fonts.bunny.net`, and versioned assets under `https://persistent.oaistatic.com/plugins/visualize/`. Images may use `data:` and `blob:` URLs. Do not use `fetch`, XHR, WebSockets, or other network APIs.

## Optional host features

- Read `window.openai.theme` and `window.openai.visualizationStyleVariables` when CSS variables alone are insufficient. Listen for `openai:set_globals` and read `event.detail.globals` for updates.
- Restore from `window.openai.widgetState` and from the same global event when it carries a state snapshot. Use defaults for missing or incompatible state. After a meaningful interaction, call `window.openai.setWidgetState({ modelContent, privateContent })` and handle a rejected promise. The call replaces the full snapshot. Keep the combined JSON at or below 16 KiB and save only in response to a user interaction.
- For an action that asks the assistant to continue, call `window.openai.sendFollowUpMessage({ prompt, title })` from an explicit click. Give the action a clear label and include the relevant widget selection in `prompt`. HAPI asks the user to confirm before adding the text to the message draft. The user sends it from the composer.

## Check and show

Read back the fragment. Check the initial render, the main control, and any state or follow-up action you included. Use a browser preview when available. Place the ASCII reference below on its own line, with a blank line before and after it, in the final assistant response.

```text
visualize{"path":"/absolute/workspace/example.html","title":"Example"}
```

Use the executor's absolute file path, with JSON escaping for Windows backslashes. The optional `title` labels the widget. Add `"mode":"wide"` for a wider widget when its layout needs the space. Keep the reference outside fences, inline code, quotes, and lists in the actual response.
