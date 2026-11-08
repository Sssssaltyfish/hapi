# Seia deployment operations

This branch stores local deployment helpers and selected diagnostic evidence separately from HAPI application history. The application baseline is `6a5341eef0130c1041bc8c3454cd336ce1611902` on `main`.

## Build from a commit

Use [deployment/build_release.py](deployment/build_release.py) and its [usage guide](deployment/README.md). Every invocation exports a complete immutable Git commit, installs its lockfile in a fresh temporary directory and creates only the requested release artifacts. There is no prerequisite `native-integrated-stage` or previous checkout. Temporary build trees are removed by default.

Source artifacts are for preparing a new Hub runtime; web artifacts contain the compiled static site; CLI artifacts contain the compiled runner. This helper prepares artifacts. It does not restart services or replace a running deployment. Existing environment files and state directories belong to the installation and are not copied from this branch.

## Production entry points

- WSL Hub: `start-passkey-hub.sh` executes Bun against the deployed Hub source.
- WSL runner: `start-agy-runner.sh` selects its immutable CLI release and loads provider wrapper configuration.
- Windows legacy runner: `start-windows-runner.ps1` invokes the packaged executable with `windows-state` as its HAPI home.
- Windows Codex Native: `windows-native/run.ps1` and `supervisor.mjs` manage the shared Desktop backend. Its configuration, ownership/state files and credentials remain local.
- Windows scheduled task launcher: the source in `hidden-task-launcher` starts the PowerShell entry points without opening a terminal window.

The copied launchers document the current installation, including its paths. A relocation must update the corresponding systemd unit or scheduled task and configuration. The Native supervisor manages the Desktop daemon; deleting or restarting its live directory is not a filesystem-only migration.

## Diagnostic archive

[diagnostics/20261108](diagnostics/20261108) preserves browser fixture source, compact result reports and the measured conclusions for history continuity and running work-card rendering. It excludes browser profiles, compiled bundles, dependencies and full browser trace payloads. Historical report paths describe the environment of that run; rebuild the recorded application commit to reproduce a bundle.

The font environment effect was specific to the old WSL probe configuration and did not explain the observed running-versus-completed card difference. The final 4x CPU fixture still had 67 ms long frames under streaming load; it was not a measurement on the user's physical phone.

`diagnostics/legacy` preserves the small source changes found only in the obsolete nested checkout or stage. These are historical investigation files, not executable deployment entry points.

## Runtime state and handoff

Git stores source, not HAPI databases, Codex conversation state, Passkey credentials or installation secrets. Those remain in the installation's state directories. Old build copies and database snapshots are intentionally not retained here.

The directory named `dsh-web-shell-kit-20261027` is the current handoff source despite its historical name. Its HAPI manifest is updated through the baseline above. `deployment/finalize-handoff.py` publishes its sealed files to the single `service-deployment-handoff.7z` archive. It retains the internal packaging timestamp and SHA-256 sidecar.
