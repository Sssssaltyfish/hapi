# Deployment operations

This branch stores deployment source and selected historical diagnostics separately from HAPI application history. `ARCHIVE.json.currentApplicationCommit` identifies current application source; its older `applicationCommit` records the initial archive baseline.

Current instructions start at [deployment/README.md](deployment/README.md). Windows uses system `wscript.exe`, a small JScript bootstrap and PowerShell supervision, with separate limited user logon tasks for the backend, Desktop, Runner and WSL keeper. Optional ARSO restores the prior user session after eligible shutdowns. WSL applications use systemd. Private target-machine settings are supplied separately; example values are fictional.

`deployment/docs/` contains the guides exported to the handoff root. Their cross-links refer to the distribution layout. Deployment source is copied from this branch; application code is distributed as upstream commit plus patch series. No previous modified checkout is required to build a release.

## Historical evidence

`diagnostics/` records dated investigations, source variants and compact reports. Paths and observed states there describe that historical run, not current deployment instructions. Rebuild the recorded application commit to reproduce an artifact. Old directory-migration scripts, authentication bootstrap and custom compiled task launcher have been retired; their original implementations remain available in Git history.

Git does not contain live runtime config, databases, credentials or Codex conversation state. Keep these in the target installation and its private backup. Deployment and development directories are independent.

## Distribution

Maintain one packaging workspace wherever convenient. `deployment/finalize-handoff.py` publishes its sealed contents to the fixed `service-deployment-handoff.7z` filename with an internal timestamp and checksum sidecar. No WSL mirror or host-specific staging path is required. Historical diagnostics are not automatically exported.
