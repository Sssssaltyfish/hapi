# Prepare a HAPI release in WSL

Run the helper in Linux/WSL with Python 3.12 or later. It uses the selected Git executable and source repository. Each build extracts the requested full commit into a temporary directory and runs `bun install --frozen-lockfile` there. The helper publishes completed artifacts and their manifest.

Set `commit` to the full commit ID you intend to release. These paths are fictional examples. Bun and Node are discovered on PATH or supplied explicitly.

```sh
python3 /srv/example/ops/deployment/build_release.py source web \
  --repo /srv/example/hapi-source --commit "$commit" \
  --output-dir "$HOME/.cache/hapi/artifacts/$commit"
```

Choose any combination of `source`, `web`, and `cli`.

| Target | Output | Contents |
| --- | --- | --- |
| `source` | `source.tar.gz` | The committed workspace tree with its lockfile. Can be prepared without Bun. |
| `web` | `web-dist.tar.gz` | The Vite output at `web/dist`, including its index and static assets. |
| `cli` | `cli.tar.gz` | The executable at `cli/dist-exe/<target>/hapi` or `hapi.exe`. The default target matches the build host. |

The manifest records the commit, chosen targets, and SHA-256 and size of each archive. Web and CLI builds also record the lockfile hash and Bun and Node versions. CLI builds run the repository's `download:tunwg` step before `build:exe`. That step fetches upstream's current release, and the manifest records the actual tunwg input hashes.

Use `--cli-target bun-linux-x64-baseline` to select a CLI target explicitly. Use `--repo` and `--git` together for a different repository location or Git executable. `--build-root` selects the Linux filesystem directory for temporary trees. `--bun` and `--node-bin-dir` select the installed toolchain. Temporary trees are removed after the artifacts have been written. Use `--keep-build` to retain the printed path for inspection.

Use `--network-concurrency 8` to limit concurrent registry requests during installation. Bun also receives the proxy environment of the WSL command.

The source and web targets were built from the recorded baseline in a fresh directory before the old stage was removed; see `fresh-build-verification.json`. For a Runner release, prepare `cli` separately, extract the archive in an isolated directory and run the candidate's `--version` there.

For a later source based Hub deployment, extract `source.tar.gz` into a fresh runtime directory, extract `web-dist.tar.gz` into the same directory, and run `bun install --frozen-lockfile` there. Use the existing service configuration and data directory when the service is switched to the new source tree. The helper only prepares the release files.

## Switch existing runner sessions

After updating the runner executable, also switch idle provider sessions that still use an older executable. An `active` session is connected; that flag alone does not mean the agent is working. A newly initialized wrapper can also report lifecycle `running` while waiting for its first prompt. Use actual turn, tool, input, and ownership state to decide whether it is idle. Do not leave an idle session on the old wrapper or request confirmation merely because it is online.

Read the live Hub session immediately before switching. Defer sessions with generation, running tools or background tasks, pending approvals/questions, queued input, or an active local terminal owner. Check queued input through the messages endpoint as well as session state. For each idle resumable session, archive and reopen the existing HAPI session through the Hub APIs. Keep its provider session ID, machine, working directory, model, reasoning level, and permission selection. Wait for provider readiness and verify those values after reopening.

Restarting the manager alone does not upgrade existing provider wrappers: the systemd runner uses `KillMode=process`. Verify each replacement process uses the current executable. A wrapper that cannot resume its native session needs a proper provider resume path before switching; attaching a fresh provider thread to an existing HAPI ID loses context.

For Windows executable replacement, stop the scheduled task and verify that its exact `start-windows-runner.ps1` supervisor has exited before stopping the runner. An orphaned supervisor can otherwise restart the runner during the copy and keep `hapi.exe` locked. Identify it by the deployed script's absolute path, then stop the runner gracefully, wait for its verified process to exit, replace the executable, and start the scheduled task again.

Legacy DSH wrappers did not persist their native session ID in HAPI. For the one-time migration, identify the exact native session from the running ACP child's open `session.lock`, gracefully terminate only the verified wrapper PID, and wait for both processes to exit and HAPI to record the CLI-authored archive. Start the upgraded wrapper with both `--resume <native-id>` and `--existing-session-id <hapi-id>`. Verify that the same native lock and saved configuration are restored. Subsequent DSH switches use the regular Hub archive/reopen path.

## Install Windows boot and sign-in tasks

The maintained guide is [Windows services](docs/WINDOWS_SERVICES.md), with [optional network dependencies](docs/NETWORK_AND_ENVIRONMENT.md). Fill private `services.json` from `services.example.json` first. Run the updater in an independent elevated Windows PowerShell as the deployment owner. The full update briefly stops the shared backend and disconnects Desktop.

```powershell
.\install-background-services.ps1 -ValidateOnly
.\install-background-services.ps1
```

The WSL keeper, Windows HAPI runner, Windows Codex backend, and Codex Desktop use separate limited Interactive logon tasks. Linux systemd owns WSL services. The backend remains available while Desktop is closed.

ARSO is optional. `configure-arso.ps1` defaults to the protected-disk policy; `-Mode Always` requires an explicit choice. Migrating an existing permanent Autologon requires `-RemovePermanentAutologon`, which deletes its saved password without retrieving it. See the service guide for prerequisites and restart limits.

Tailscale uses its official service. Model connectivity, a proxy, a gateway and provider credentials belong to each target machine's environment. None of the startup wrappers requires a particular proxy client.

The default runtime is `%LOCALAPPDATA%\HAPI`; select another persistent location with `-RuntimeRoot`. The runner workspace, WSL distribution/user and optional service list come from private `services.json`. The full updater expects an existing stack; Native first installation is documented separately.

The installer verifies the Windows runner control endpoint, WSL user units, and Codex backend. If a cutover step fails, it restores the previous tasks and restarts services that were running. See `background-services\install-result.json` under the runtime for the outcome and `windows-native\state\update-result.json` for the native backend. Use `-ServicesOnly` to update the runner and WSL keeper without cycling Codex, or `install-wsl-services.ps1` to update only the keeper. These narrower modes require the shared launcher scripts to be unchanged.

Use the [Windows Desktop recovery procedure](windows-native/README.md) for subsequent supervisor changes.

## Publish the handoff

The publisher uses explicit paths and can run from any checkout location. Update the handoff's `SHA256SUMS.txt` after changing its contents, then run in WSL:

```sh
python3 /srv/example/ops/deployment/finalize-handoff.py \
  --source /srv/example/service-deployment-handoff \
  --output-dir /srv/example/distribution
```

It publishes `service-deployment-handoff.7z` and its checksum sidecar, with `PACKAGED_AT.txt` inside. It compares maximum-compression PPMd and LZMA2 archives and keeps the smaller one. Temporary archives are removed after publication.

Keep a single packaging workspace and the latest fixed-name archive. Its location is independent of the live installation and requires no mirrored checkout.
