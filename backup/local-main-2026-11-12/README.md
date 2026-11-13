# Backup of a local `main` (2026-11-12)

A local checkout's `main` carried 58 commits that are not on colinhacks/frizz `main`. Ten of them never reached
upstream at all; the rest shipped through PRs, were superseded, or were housekeeping. This branch keeps them off
that one machine. It is a standalone commit, not a branch of Frizz's history: its history contains workflow-file
changes that this push credential is not allowed to publish, so the history travels as a git bundle instead.

- `local-main.bundle`: every commit of that `main` from `upstream/main..main`, exact hashes, head `f754199c`.
- `unshipped/`: the ten commits that never reached upstream, as `git format-patch` files to read or `git am`.

## Restore

From any clone of colinhacks/frizz whose `main` contains the bundle's four prerequisite commits (all on upstream
`main`):

```sh
git fetch path/to/local-main.bundle main:refs/heads/local-main-restored
```

## The ten unshipped commits

| Patch | Date | Feature |
|---|---|---|
| 01 `3620fb33` | 2026-09-29 | Plan doc: propagate Claude 1M context to sub-agents |
| 02 `67f3bbdb`, 07 `f49bb5f4` | 2026-09-23, 2026-10-10 | Dev script: preview the source UI against the live Frizz server, with a Tailscale origin |
| 03 `b19148e8`, 04 `90130405` | 2026-10-09 | Sort the queue with clickable headers; keep sequential review order |
| 05 `4e8afed6`, 06 `5284914e` | 2026-10-09 | Phone queue review deck with a fixed recommendation bar |
| 08 `cd7e310a` | 2026-10-20 | Settings: a separate opener for Markdown links |
| 09 `53b76f6b` | 2026-10-28 | One snooze behaviour on desktop and mobile |
| 10 `f754199c` | 2026-10-29 | A red PR watch wakes when its last running check finishes |
