# Model filters

In **Settings → General → Model filters**, choose a harness and enter the models
to show in its pickers. The Hub owner saves these rules for all connected devices.
Codex Native has its own entry, separate from the Codex runner.

- `gemini-*` shows Gemini model IDs in Antigravity.
- `sonnet*, opus*` shows matching Claude aliases or names.
- A plain word matches anywhere in the model ID or display name; `*` matches any
  number of characters. Matching ignores case. Separate rules with commas.
- Clear the field and save to show the complete catalog again.

Filtering applies to session creation, in-session model selection, and the model
cycling shortcut. Default/Auto and an existing selection remain visible. Rules
do not alter provider configuration, the discovered catalog, effort support, or
the model used by an existing session. New matching models appear automatically
when the provider's catalog refreshes.
