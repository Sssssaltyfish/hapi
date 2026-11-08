# Seia deployment operations

This branch stores local deployment helpers and selected diagnostic evidence separately from HAPI application history. The application baseline is `6a5341eef0130c1041bc8c3454cd336ce1611902` on `main`.

## Build from a commit

Use [deployment/build_release.py](deployment/build_release.py) and its [usage guide](deployment/README.md). Every invocation exports a complete immutable Git commit, installs its lockfile in a fresh temporary directory and creates only the requested release artifacts. There is no prerequisite `native-integrated-stage` or previous checkout. Temporary build trees are removed by default.

Source artifacts are for preparing a new Hub runtime; web artifacts contain the compiled static site; CLI artifacts contain the compiled runner. This helper prepares artifacts. It does not restart services or replace a running deployment. Existing environment files and state directories belong to the installation and are not copied from this branch.

## Production directories and entry points

- WSL runtime root: `/home/igna/.local/share/hapi`. `current` selects a source release under `releases/`; `bin/start-passkey-hub.sh` executes its Hub with the runtime's Bun. Release source is exported from a Git commit, with no deployment Git checkout.
- WSL runner: `bin/start-agy-runner.sh` selects its immutable `cli-releases` executable and loads provider wrapper configuration. HAPI state remains `/home/igna/.hapi`.
- Windows runtime root: `%LOCALAPPDATA%\HAPI`. `start-windows-runner.ps1` invokes `package/bin/hapi.exe` with `windows-state` as its HAPI home. The default session workspace remains the user's `codex-temp` directory.
- Windows Codex Native: `windows-native/run.ps1` and `supervisor.mjs` manage the shared Desktop backend. Configuration, ownership/state files and credentials remain in that runtime root. The actual Codex home is unchanged.
- Windows scheduled task launcher: the source in `hidden-task-launcher` starts the PowerShell entry points without opening a terminal window. Registered actions point to the runtime copy.
- Development stays in the Windows `hapi-deployment/source` checkout and this `ops` worktree. Temporary build trees use `~/.cache/hapi/builds`; production does not need the development checkout to start.

The source launchers are copied to the runtime installation. A relocation must update the corresponding systemd unit or scheduled task and configuration. `deployment/migrate-windows-runtime.ps1` performs the one-time move from the original workspace layout; it prepares the new tree, stops the owned tasks, copies state, updates task actions and checks the new runtime, with rollback on failure. Run it from a separate scheduled task because Native migration restarts Desktop and its daemon.

## Diagnostic archive

[diagnostics/20261108](diagnostics/20261108) preserves browser fixture source, compact result reports and the measured conclusions for history continuity and running work-card rendering. It excludes browser profiles, compiled bundles, dependencies and full browser trace payloads. Historical report paths describe the environment of that run; rebuild the recorded application commit to reproduce a bundle.

The font environment effect was specific to the old WSL probe configuration and did not explain the observed running-versus-completed card difference. The final 4x CPU fixture still had 67 ms long frames under streaming load; it was not a measurement on the user's physical phone.

`diagnostics/legacy` preserves the small source changes found only in the obsolete nested checkout or stage. These are historical investigation files, not executable deployment entry points.

## Runtime state and handoff

Git stores source, not HAPI databases, Codex conversation state, Passkey credentials or installation secrets. Those remain in the installation's state directories. Old build copies and database snapshots are intentionally not retained here.

`C:\Users\Igna\codex-temp\service-deployment-handoff` is the persistent Windows packaging workspace. There is no WSL mirror. `deployment/finalize-handoff.py` publishes its sealed files to the single `service-deployment-handoff.7z` archive beside it, with an internal packaging timestamp and SHA-256 sidecar. The application manifest is updated through the baseline above.
