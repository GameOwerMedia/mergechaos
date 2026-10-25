# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-25

### Added
- `inventory`: map of every repository: worktrees (clean, live, stale, missing), unmerged branches, premerge reports, overlaps, conflicts predicted against the base and between branches.
- `plan`: draft plan with TAKE / ASK / ARCHIVE verdicts in dependency order, questions with options for every ASK.
- `integrate`: merges TAKE branches into `merge/<stamp>` in a separate worktree; stops on conflicts and resumes.
- `rescue`: commits a dead session's uncommitted work onto a rescue branch through a temporary index (literal pathspecs), with a manifest of what was left out. Private names and credential-like contents (UTF-16 decoded) stay out; best effort, shared with premerge in `safety.mjs`.
- `land`: EQUAL / SAFE / COLLIDE classification checked twice against the disk; writes only paths that hold the old base content with no file in the way of their folders; merges the base change byte for byte into edited text files when clean; leaves every other path as it is, with its index entry back at the old base; applies pure exec-bit changes where the filesystem has them.
- `archive`: rescue branches and ARCHIVE verdicts become `archive/*` tags.
- Reads premerge reports from branches and registries; works without them.
- Claude Code skill and plugin manifests.
