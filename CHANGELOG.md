# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-25

### Added
- `inventory`: map of every repository: worktrees (clean, live, stale, missing), unmerged branches, premerge reports, overlaps, conflicts predicted against the base and between branches.
- `plan`: draft plan with TAKE / ASK / ARCHIVE verdicts in dependency order, questions with options for every ASK.
- `integrate`: merges TAKE branches into `merge/<stamp>` in a separate worktree; stops on conflicts and resumes.
- `rescue`: commits a dead session's uncommitted work onto a rescue branch through a temporary index (literal pathspecs), with a manifest of what was left out. Private names and credential-like contents (UTF-16 decoded) stay out; best effort, shared with premerge in `safety.mjs`.
- `land`: EQUAL / SAFE / COLLIDE classification checked twice against the disk; writes only paths that hold the old base content with no file in the way of their folders; applies pure exec-bit changes where the filesystem has them. Any COLLIDE path refuses the landing by default (exit 7, nothing written, base not moved). `--allow-collisions` lands the SAFE paths anyway, merges the base change byte for byte into edited text files when clean, and leaves every other path as it is with its index entry back at the old base (exit 8, with a warning that a plain commit there would record a revert).
- `land` guards read every worktree's git dir: the landing stops (exit 1) while the base is being rebased or bisected in any worktree, while a merge, cherry-pick, revert, rebase or bisect is in progress where it is checked out, and when it is checked out in more than one worktree.
- `land` on case-insensitive filesystems classifies case-only renames as COLLIDE; submodule pointer changes are SAFE and only move the index entry; a folder that becomes a file never leaves a folder entry in the index.
- `rescue` checks file sizes before reading (files above 1 GiB are listed without a hash) and leaves out paths reached through links or junctions that resolve outside the worktree.
- `archive`: rescue branches and ARCHIVE verdicts become `archive/*` tags. Branches in use by a rebase, bisect, merge, cherry-pick or revert in any worktree are skipped and keep their ref.
- Reads premerge reports from branches and registries; works without them.
- Claude Code skill and plugin manifests.
