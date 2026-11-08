#!/usr/bin/env python3
"""Prepare HAPI release artifacts from an immutable Git commit."""

import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_tree(root, relative_path, destination):
    with tarfile.open(destination, "w:gz") as archive:
        archive.add(root / relative_path, arcname=relative_path)


def prepare(args):
    git = [args.git, "--no-replace-objects", "-C", args.repo]
    commit = subprocess.check_output(
        [*git, "rev-parse", "--verify", f"{args.commit}^{{commit}}"], text=True
    ).strip()
    if commit != args.commit.lower():
        raise ValueError("--commit must name the commit itself")

    output = args.output_dir.expanduser().absolute()
    if output.exists() or output.is_symlink():
        raise ValueError(f"Output directory already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    targets = sorted(set(args.targets))
    manifest = {"commit": commit, "targets": targets}

    with ExitStack() as cleanup:
        pending = Path(cleanup.enter_context(tempfile.TemporaryDirectory(
            dir=output.parent, prefix=f".{output.name}-"
        )))
        source_archive = pending / "source.tar.gz"
        with source_archive.open("wb") as stream:
            subprocess.run([*git, "archive", "--format=tar.gz", commit], stdout=stream, check=True)

        if "web" in targets or "cli" in targets:
            build_root = args.build_root.expanduser().resolve()
            build_root.mkdir(parents=True, exist_ok=True)
            build_options = {"dir": build_root, "prefix": f"hapi-{commit[:12]}-"}
            if args.keep_build:
                build = Path(tempfile.mkdtemp(**build_options))
                print(f"Retained build directory: {build}", flush=True)
            else:
                build = Path(cleanup.enter_context(tempfile.TemporaryDirectory(**build_options)))
            source = build / "source"
            source.mkdir()
            with tarfile.open(source_archive, "r:gz") as archive:
                archive.extractall(source, filter="data")

            bun = args.bun.expanduser().absolute()
            node_bin_dir = args.node_bin_dir.expanduser().absolute()
            env = dict(os.environ, PATH=os.pathsep.join((
                str(bun.parent), str(node_bin_dir), "/usr/bin", "/bin", os.environ.get("PATH", "")
            )))
            env.setdefault("NODE_OPTIONS", "--no-experimental-webstorage")
            manifest["tools"] = {
                "bun": subprocess.check_output([bun, "--version"], env=env, text=True).strip(),
                "node": subprocess.check_output(["node", "--version"], env=env, text=True).strip(),
            }
            manifest["bunLockSha256"] = sha256(source / "bun.lock")

            def run_bun(*command):
                subprocess.run([bun, *command], cwd=source, env=env, check=True)

            install_options = []
            if args.network_concurrency is not None:
                install_options.append(f"--network-concurrency={args.network_concurrency}")
            run_bun("install", "--frozen-lockfile", *install_options)
            if "web" in targets:
                run_bun("run", "build:web")
                if not (source / "web/dist/index.html").is_file():
                    raise ValueError("Web build did not produce web/dist/index.html")
                archive_tree(source, "web/dist", pending / "web-dist.tar.gz")

            if "cli" in targets:
                run_bun("run", "download:tunwg")
                cli_options = ["--target", args.cli_target] if args.cli_target else []
                run_bun("run", "--cwd", "cli", "build:exe", *cli_options)
                executables = sorted(
                    path for path in (source / "cli/dist-exe").glob("*/*")
                    if path.name in {"hapi", "hapi.exe"} and path.is_file()
                )
                if len(executables) != 1:
                    raise ValueError("Expected one HAPI executable under cli/dist-exe")
                executable = executables[0].relative_to(source)
                manifest["cliExecutable"] = executable.as_posix()
                manifest["tunwgSha256"] = {
                    path.name: sha256(path) for path in sorted((source / "shared/tools/tunwg").iterdir())
                    if path.is_file()
                }
                archive_tree(source, executable.as_posix(), pending / "cli.tar.gz")

        if "source" not in targets:
            source_archive.unlink()
        manifest["artifacts"] = {
            path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in sorted(pending.iterdir())
        }
        (pending / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        pending.rename(output)

    print(output / "manifest.json", flush=True)


def main():
    home = Path.home()
    deployment = home / ".local/share/hapi"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="+", choices=("source", "web", "cli"))
    parser.add_argument("--commit", required=True, help="full commit ID in the source repository")
    parser.add_argument("--output-dir", required=True, type=Path, help="new directory for the finished artifacts")
    parser.add_argument("--repo", default="C:/Users/Igna/codex-temp/hapi-deployment/source",
                        help="repository path as seen by the chosen Git executable")
    parser.add_argument("--git", default="/mnt/c/Program Files/Git/cmd/git.exe", help="Git executable")
    parser.add_argument("--build-root", type=Path, default=home / ".cache/hapi/builds",
                        help="WSL directory for temporary build trees")
    parser.add_argument("--bun", type=Path, default=deployment / "build-tools/bun/bin/bun",
                        help="Bun executable")
    parser.add_argument("--node-bin-dir", type=Path, default=home / ".nvm/current/bin",
                        help="directory containing Node.js")
    parser.add_argument("--cli-target", help="target accepted by the CLI build, defaults to the build host")
    parser.add_argument("--network-concurrency", type=int, help="maximum concurrent requests during Bun install")
    parser.add_argument("--keep-build", action="store_true", help="retain the temporary build tree for inspection")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", args.commit):
        parser.error("--commit must be a full Git commit ID")
    if args.cli_target and "cli" not in args.targets:
        parser.error("--cli-target requires the cli target")
    if args.network_concurrency is not None and args.network_concurrency < 1:
        parser.error("--network-concurrency must be positive")
    try:
        prepare(args)
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"Release preparation failed: {error}")


if __name__ == "__main__":
    main()
