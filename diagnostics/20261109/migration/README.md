# Runtime relocation record

These scripts and receipts describe the one-time 2026-11-09 move from the development workspace to dedicated runtime directories. They use the original installation paths and are historical operation records, not general installation commands.

The Windows scheduling and completion scripts run from the original `hapi-deployment/runtime-separation-20261109` task directory. The scheduler launches the completion script independently of Desktop so it can finish after Native restarts the Desktop daemon. The completion script invokes the versioned migration helper, checks the new task actions and removes only the enumerated obsolete runtime copies.

WSL uses a complete Git export for its source release and reuses the existing dependency tree and static build. The recorded old source comparison includes the three local audit helpers; all are preserved in the authoritative development checkout or the older ops diagnostic archive. The remaining generated manifest, old log and unused relay executable were reproducible or disposable.

Runtime configuration and credential files are excluded from this archive. Actual final Windows readiness is recorded by `windows-cutover-result.json` in the local task directory and the new runtime root.
