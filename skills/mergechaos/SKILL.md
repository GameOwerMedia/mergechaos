---
name: mergechaos
description: Untangle many branches, worktrees and half-finished agent sessions across one or more git repositories, then merge them safely. Builds an inventory from git (unmerged branches, ahead/behind, worktrees, uncommitted work, stale sessions, premerge reports, overlapping files, predicted conflicts), drafts a plan with a verdict per branch (TAKE, ASK when the purpose is not understood, ARCHIVE), merges the TAKE branches in dependency order on an integration branch in a separate worktree, rescues dead sessions' uncommitted work onto rescue branches, and lands the result without overwriting anyone's uncommitted edits. Use when the user says "mergechaos", "merge everything", "clean up all these branches", "too many worktrees", "the agents left a mess", or asks to merge the work of many parallel sessions.
argument-hint: "[--repo <dir> ...]"
---

# mergechaos

One repository with two branches is a `git merge`. Ten agents across three repositories, each with a branch, a worktree and some uncommitted files, is chaos: commits ahead of and behind the base, reports missing or stale, the same file edited in three places, sessions that died in the middle of an edit. mergechaos turns that into a list of facts, a plan a person can approve, and a landing that writes only paths it has verified and leaves everything else as it found it.

The tool is one dependency-free script: `node "${CLAUDE_SKILL_DIR}/scripts/mergechaos.mjs"` (Node.js 20+, git 2.25+; 2.38+ for conflict prediction). Below it is written as `mergechaos`. It reads the reports written by the companion skill **premerge** (`docs/premerge/<branch>.md` on each branch), and works without them too: a branch without a report simply gets the verdict ASK.

## Character: devil's advocate, never a yes-man

- Merge nothing you do not understand. For every branch you must be able to say, in one sentence, why it exists.
- If you cannot, the verdict is ASK: ask the author or the user, with options and a recommendation. Never guess.
- Report drift (a change that contradicts the project's documented direction or an earlier decision of the user) instead of carrying it out.
- Facts come from git through the tool; your judgement goes into the plan, with a reason on every line.

## The flow

### 1. Inventory (no model needed)
`mergechaos inventory --repo <dir> [--repo <dir> ...] [--days 30] [--stale-hours 24] [--out <run dir>]`

Writes `MAP.md` and `map.json` into the run folder (default `~/.mergechaos/runs/<stamp>`, or `$MERGECHAOS_DIR/<stamp>`). Per repository: base and production branches; every worktree with its state (`clean`, `live`, `stale` = uncommitted edits older than `--stale-hours`, `missing` = registered but gone from disk); every unmerged branch with ahead/behind, commits, files, its premerge report (current or stale), whether its commits are already in the base under other hashes; files changed by several branches; conflicts predicted against the base and between pairs of branches (`git merge-tree`). Linked worktrees are counted once, with their main repository.

### 2. Missing and stale reports
For every branch marked **missing** or **(stale)**, ask its author (the session that owns the worktree or the branch) to run premerge. If the author is gone, you may write a report from the commits yourself with `premerge report --why "<your reading>" --author reconstructed --status wip --commit`; the plan treats such reports as ASK until the user confirms.

### 3. Plan
`mergechaos plan --run <run dir>` drafts `PLAN.md` and `plan.json`:
- **TAKE**: a current report with a stated purpose, status ready, dependencies also taken. Order: dependencies first (`dependsOn`), then clean merges before conflicting ones.
- **ASK**: no report, no purpose, stale report, `wip`, reconstructed, or a dependency that is not taken.
- **ARCHIVE**: rescue branches, and branches whose commits are already in the base.

Then do the real work of the plan: read MAP.md, every report, and the project's own documents (README, CONTRIBUTING, architecture notes). Edit `plan.json` (verdict, reason, order). The script never turns ASK into TAKE; only you may, and only with a one-sentence purpose in `reason`. To take part of a branch, create a new branch from the base with the chosen commits (`git cherry-pick`) and take that branch instead. For a large or risky plan, use the strongest model available at high effort, or hand the plan to a separate planner subagent.

### 4. Second opinion and questions
For every ASK and ARCHIVE verdict, and anything that touches a production branch, get a second opinion from an independent subagent (PRO and CONTRA, one sentence each). Put all questions in one list for the user: options best first, recommendation first, pros and cons, and whether the question blocks. Work on branches that are not blocked continues.

### 5. Integrate
`mergechaos integrate --run <run dir>` creates `merge/<stamp>` from the recorded base tip in a separate worktree (`<run>/wt/<repo>`) and merges the TAKE branches in plan order with real merge commits. It never moves the base. On a conflict it stops (exit 6) and lists the files: resolve them in that worktree keeping both sides, `git commit --no-edit`, and run `integrate` again; finished merges are skipped. Then run the tests every report lists, inside the integration worktree, and review the combined diff. Regenerate derived files (lockfiles, generated manifests) after the last merge instead of hand-merging them.

### 6. Rescue dead sessions
For every **stale** worktree: `mergechaos rescue --worktree <dir>`. It commits all uncommitted work (edits, deletions, untracked files) onto `rescue/<worktree>/<date>` through a temporary index, with a manifest `.mergechaos/RESCUE.md`. The worktree, its index and its HEAD do not change. Well-known private file names, contents that look like credentials (best effort) and files above `--max-mb` (checked by size before reading) stay out and are listed by path, size and hash, never by content; so do paths reached through a link or junction that resolves outside the worktree. In this flow a **live** worktree is reported, never rescued: its owner commits and writes a report. The `rescue` command itself does not check liveness and rescues any worktree you name, so only point it at stale ones.

### 7. Land (only with the user's go-ahead)
`mergechaos land --repo <dir> --base <base> --old <recorded base tip> --new merge/<stamp> [--dry-run] [--allow-collisions]`

Guards: the base still points at `--old` (otherwise merge the new base commits into the integration branch, retest, and update `--old`), the integration commit contains the base, no worktree is rebasing the base or bisecting from it, the base is checked out in at most one worktree, and in that worktree nothing is staged and no merge, cherry-pick, revert, rebase or bisect is in progress. A guard stop (exit 1) changes nothing: tell the user which worktree is busy and wait for its owner to finish or abort. Then every path that changes is classified:
- **EQUAL**: the disk already holds the new content; nothing is written.
- **SAFE**: the disk still holds the old base content and no file blocks its folders; the new content is written. A submodule pointer bump is SAFE too: only the index entry moves, the nested repository is never touched (tell the owner to run `git submodule update`).
- **COLLIDE**: anything else (an uncommitted edit, a file in the way of a new folder, a symlink, a submodule that changes type or lands on existing files, and on case-insensitive filesystems a case-only rename).

By default one COLLIDE path refuses the landing (exit 7): nothing is written and the base does not move. Show the user the paths and ask the owner of that worktree to commit or stash those edits (or move away what is in the way), then run the same command again. This is the normal path.

`--allow-collisions` lands anyway, only when the user explicitly accepts unresolved paths. SAFE paths are written and the base moves. For an edited text file the base change is merged three-way into the edit, byte for byte, when it merges cleanly. Every other COLLIDE path is left exactly as it is on disk (exit 8) with its index entry back at the old base. Tell the owner plainly: until they resolve those files, a plain `git commit` in that worktree records a revert of the landed change on them. `git diff` shows their edit; `git diff --cached -R -- <path>` is the landed change to bring in by hand before committing.

The base ref moves atomically (old-value check) and the worktree's index follows it without touching any other file. If the base is not checked out anywhere, only the ref moves. Always run `--dry-run` first and show the table; it also says whether a real run would refuse. Never push and never deploy as part of this flow; those are separate decisions of the user.

### 8. Archive and finish
`mergechaos archive --repo <dir> --branch <rescue branches and ARCHIVE verdicts>` tags each as `archive/<branch>` and removes the branch ref; the commits stay reachable. A branch that is being rebased or bisected in any worktree, or is checked out with a merge, cherry-pick or revert in progress, is skipped with the reason and keeps its ref; so is a branch that is only checked out, unless `--keep-branch`. Report skipped branches to the user instead of working around them. Remove the integration worktree (`git worktree remove <run>/wt/<repo>`) and delete `merge/<stamp>` once the base points at it. `git worktree prune` only for worktrees the user confirmed as gone.

Finish with a short account per repository: merged, archived, rescued, waiting (ASK), unresolved collisions, tests run, and the open questions. The flow ends here.

## Hard rules
- Never `checkout`, `stash`, `reset`, `clean` or `rebase` in a working tree that someone else may be using. The tool only writes to the integration worktree, to new branch refs, and, during `land`, to SAFE paths (and, only with `--allow-collisions`, to clean three-way merges into edited files).
- Never pass `--allow-collisions` on your own; it needs the user's explicit yes after they have seen the colliding paths.
- Never take another session's uncommitted hunks into a merge. Rescue them to a rescue branch; cherry-pick from there only what the owner approves.
- Do not kill processes or close other sessions.
- Real merge commits; no history rewriting of shared branches.
- No secrets or private files in commits, reports, plans or messages.

Plan file fields and the premerge contract: `${CLAUDE_SKILL_DIR}/references/plan-json.md`.
