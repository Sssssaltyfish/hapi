# Prepare a HAPI release in WSL

Run the helper as `igna` in `Ubuntu-26.04` with Python 3.12 or later. It uses Git for Windows to read the full commit ID in the authoritative Windows repository. Each build extracts that commit into its own temporary WSL directory and runs `bun install --frozen-lockfile` there. The helper finishes by moving the completed artifacts and their manifest into the requested new output directory.

From PowerShell, set `$commit` to the full commit ID you intend to release. This example prepares the files for a future source based Hub deployment.

```powershell
$helper = '/mnt/c/Users/Igna/codex-temp/hapi-deployment/ops/deployment/build_release.py'
$release = "/home/igna/.cache/hapi/artifacts/$commit"
wsl -d Ubuntu-26.04 -u igna -- python3 $helper source web --commit $commit --output-dir $release
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

After updating the runner executable, also switch idle provider sessions that still use an older executable. An `active` session is connected; that flag alone does not mean the agent is working. Do not leave an idle session on the old wrapper or request confirmation merely because it is online.

Read the live Hub session immediately before switching. Defer sessions with generation, running tools or background tasks, pending approvals/questions, queued input, or an active local terminal owner. Check queued input through the messages endpoint as well as session state. For each idle resumable session, archive and reopen the existing HAPI session through the Hub APIs. Keep its provider session ID, machine, working directory, model, reasoning level, and permission selection. Wait for provider readiness and verify those values after reopening.

Restarting the manager alone does not upgrade existing provider wrappers: the systemd runner uses `KillMode=process`. Verify each replacement process uses the current executable. A wrapper that cannot resume its native session needs a proper provider resume path before switching; attaching a fresh provider thread to an existing HAPI ID loses context.

Legacy DSH wrappers did not persist their native session ID in HAPI. For the one-time migration, identify the exact native session from the running ACP child's open `session.lock`, gracefully terminate only the verified wrapper PID, and wait for both processes to exit and HAPI to record the CLI-authored archive. Start the upgraded wrapper with both `--resume <native-id>` and `--existing-session-id <hapi-id>`. Verify that the same native lock and saved configuration are restored. Subsequent DSH switches use the regular Hub archive/reopen path.

## Publish the handoff

The publisher uses explicit paths and can run from any checkout location. Update the handoff's `SHA256SUMS.txt` after changing its contents, then run in WSL:

```sh
python3 /mnt/c/Users/Igna/codex-temp/hapi-deployment/ops/deployment/finalize-handoff.py \
  --source /mnt/c/Users/Igna/codex-temp/service-deployment-handoff \
  --output-dir /mnt/c/Users/Igna/codex-temp
```

It publishes `service-deployment-handoff.7z` and its checksum sidecar, with `PACKAGED_AT.txt` inside. It compares maximum-compression PPMd and LZMA2 archives and keeps the smaller one. Temporary archives are removed after publication.

The Windows source directory is the only persistent packaging workspace. There is no WSL handoff mirror. Keep only the latest fixed-name distribution archive.
