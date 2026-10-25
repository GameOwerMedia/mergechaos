<p align="center"><img src="assets/banner.svg" alt="mergechaos: from many branches and dead sessions to one clean base" width="100%"></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://github.com/GameOwerMedia/mergechaos/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/GameOwerMedia/mergechaos/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Claude Code skill" src="https://img.shields.io/badge/Claude%20Code-skill-d97757.svg">
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-brightgreen.svg">
</p>

**mergechaos** turns the state many parallel agents leave behind (branches ahead of and behind the base, worktrees, uncommitted files of sessions that died, reports missing or stale) into a fact sheet, a merge plan that asks before it guesses, and a landing on the base branch that never overwrites anyone's uncommitted work.

<p align="center"><img src="assets/demo.svg" alt="Terminal: inventory and plan of acme-shop, integrate stops on a conflict and resumes after it is resolved, a stale session is rescued, land classifies paths as SAFE and COLLIDE and merges the base change into a live edit, archive tags the leftovers" width="100%"></p>

The run above is [examples/demo.mjs](examples/demo.mjs) on a throwaway repository. Its generated [MAP.md](docs/example/MAP.md), [PLAN.md](docs/example/PLAN.md) and [full transcript](docs/example/transcript.txt) are in `docs/example/`.

## Why

Running several coding agents at once is easy. Merging what they leave is not:

- Every session has its own branch or worktree, some commit straight onto the base, some stop in the middle of an edit.
- Nobody knows which branch is still needed, which is already in the base under another hash, and which depends on which.
- The obvious clean-up commands (`git checkout`, `git stash`, `git reset`, `git clean`) destroy the uncommitted work of sessions that are still running.

mergechaos separates the facts (collected by a script, no model involved) from the judgement (a plan with a reason on every line, written by an agent and approved by a person), and executes the plan with git plumbing that only ever writes to places it owns: a separate integration worktree, new branch refs, and, at the very end, the paths of the base worktree that provably hold no one's edits.

## Install

**As a Claude Code plugin**

```
/plugin marketplace add GameOwerMedia/mergechaos
/plugin install mergechaos@mergechaos
```

**As a plain skill** (copy the folder):

```bash
git clone https://github.com/GameOwerMedia/mergechaos
cp -r mergechaos/skills/mergechaos ~/.claude/skills/
```

**As a command-line tool** (no install step; Node.js 18+ and git 2.38+):

```bash
alias mergechaos="node ~/.claude/skills/mergechaos/scripts/mergechaos.mjs"
mergechaos --help
```

Recommended companion: **[premerge](https://github.com/GameOwerMedia/premerge)**, which lets each agent leave a report on its branch saying why it exists. mergechaos reads those reports; without them every branch is treated as "purpose unknown".

## Quick start

In Claude Code: *"mergechaos ~/work/acme-shop ~/work/acme-api"*. The skill walks the agent through the flow below and stops for your go-ahead before anything touches a base branch. By hand:

```bash
mergechaos inventory --repo ~/work/acme-shop --repo ~/work/acme-api   # MAP.md + map.json in ~/.mergechaos/runs/<stamp>
mergechaos plan --run ~/.mergechaos/runs/<stamp>                         # PLAN.md + plan.json: TAKE / ASK / ARCHIVE
# read the reports, answer the ASK questions, edit plan.json
mergechaos integrate --run ~/.mergechaos/runs/<stamp>                    # merge/<stamp> in <run>/wt/<repo>; run the tests there
mergechaos rescue --worktree ~/work/acme-shop-theme                      # dead session -> rescue/<name>/<date>
mergechaos land --repo ~/work/acme-shop --base main --old <baseTip> --new merge/<stamp> --dry-run
mergechaos land --repo ~/work/acme-shop --base main --old <baseTip> --new merge/<stamp>
mergechaos archive --repo ~/work/acme-shop --branch rescue/acme-shop-theme/<date>,agent-d/typo
```

## How it works

<p align="center"><img src="assets/flow.svg" alt="Flow: agents leave branches; premerge reports state why; the mergechaos plan gives TAKE, ASK or ARCHIVE; integrate merges in a separate worktree; land compares the disk path by path: EQUAL, SAFE, COLLIDE" width="100%"></p>

**1. Inventory.** For each repository (linked worktrees are folded into their main repository): base and production branches; each worktree as `clean`, `live`, `stale` (uncommitted edits untouched for `--stale-hours`) or `missing`; each unmerged branch with ahead/behind, commits, files, its premerge report and whether that report is current; branches whose commits are already in the base under other hashes (`git cherry`); files changed by several branches; conflicts predicted against the base and between pairs of branches (`git merge-tree --write-tree`, nothing is written).

**2. Plan.** One verdict per branch, in dependency order:

| Verdict | When | What happens |
|---|---|---|
| **TAKE** | A current report states why the branch exists, status is ready, its dependencies are taken too. | Merged by `integrate`, the reason goes into the merge commit message. |
| **ASK** | No report, no purpose, a stale or reconstructed report, `wip`, or a dependency that is not taken. | Nothing. The plan lists a question with options and a recommendation. Only a person, or an agent that can now state the purpose, turns it into TAKE. |
| **ARCHIVE** | Rescue branches; branches whose commits are already in the base. | Tagged `archive/<branch>` by `archive`; the branch ref goes away, the commits stay. |

The script drafts the plan mechanically and never upgrades ASK to TAKE. The skill then has the agent read every report and the project's own docs, get an independent second opinion on ASK and ARCHIVE verdicts, and bring the open questions to you in one list.

**3. Integrate.** `merge/<stamp>` is created from the base tip recorded in the plan, in its own worktree under the run folder. TAKE branches are merged in order with real merge commits. A conflict stops the run (exit 6) with the file list; resolve it in that worktree, commit, and run `integrate` again: finished merges are skipped, moved branches are refused. Run the tests the reports list right there.

**4. Rescue.** A stale worktree's uncommitted changes (edits, deletions, untracked files) become a commit on `rescue/<worktree>/<date>`, built through a temporary index on top of that worktree's HEAD. Nothing in the worktree changes. Private files (`.env*`, `*.local.*`, keys), lines that look like secrets and files above `--max-mb` are left out and listed in `.mergechaos/RESCUE.md` inside the commit by path, size and SHA-256. Live worktrees are never rescued: their owner commits.

**5. Land.** Guards first: the base still points at the recorded tip, the integration commit contains it, nothing is staged and no merge is in progress where the base is checked out. Then each changed path is compared with what is on disk:

| Class | Disk holds | Action |
|---|---|---|
| **EQUAL** | the new content already | nothing |
| **SAFE** | the old base content | written from the new commit (temporary index + `checkout-index`), or deleted |
| **COLLIDE** | someone's uncommitted edit | the base change is merged three-way into the edit when it merges cleanly (line endings kept); otherwise the file is left exactly as it was and listed (exit 7) |

The base ref then moves with an old-value check, and the worktree's index follows with a two-tree `read-tree` that does not touch files. If the base is not checked out anywhere, only the ref moves.

**6. Archive.** Rescue branches and ARCHIVE verdicts become annotated `archive/*` tags; the branch refs are removed. Nothing is deleted from history. The flow ends here; pushing and deploying stay separate decisions.

## Commands

| Command | Options |
|---|---|
| `inventory` | `--repo <dir>` (repeatable or comma-separated), `--repos-file <list.txt>`, `--days 30`, `--stale-hours 24`, `--base <branch>`, `--out <run dir>`, `--json` |
| `plan` | `--run <run dir>`, `--json` |
| `integrate` | `--run <run dir>`, `--repo <name>` to limit to some repositories |
| `rescue` | `--worktree <dir>`, `--name <branch>`, `--onto <ref>` (default: the worktree's HEAD), `--max-mb 1`, `--json` |
| `land` | `--repo <dir>`, `--base <branch>`, `--old <sha>`, `--new <ref>`, `--dry-run`, `--no-merge-collisions`, `--json` |
| `archive` | `--repo <dir>`, `--branch <b>[,<b>...]`, `--prefix archive/`, `--keep-branch` |

Exit codes: `0` ok, `1` stopped by a guard, `2` usage error, `6` integrate stopped on a conflict, `7` land left collisions unresolved.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `MERGECHAOS_DIR` | `~/.mergechaos/runs` | Where run folders (`<stamp>/`) are created. |
| `PREMERGE_REGISTRY` | unset | Extra premerge registry folder to read (the per-repository `.git/premerge/registry.jsonl` is always read). |
| `--stale-hours` | `24` | Age of the newest uncommitted edit after which a worktree counts as a dead session. |
| `--days` | `30` | Branches without commits in this window are left out of the inventory (rescue branches always count). |

The base branch is detected from `origin/HEAD`, then `main`, `master`, `trunk`, `develop`; pass `--base` to override. Production-like branches (`prod*`, `production*`, `release*`, `main`, `master` other than the base) are reported with their lag. Run-folder files and `plan.json` fields: [skills/mergechaos/references/plan-json.md](skills/mergechaos/references/plan-json.md).

## FAQ

**Can it run without premerge?**
Yes. Branches without a report get ASK with "purpose unknown", which is exactly what an unexplained branch deserves. The agent can still write the purpose into `plan.json` after reading the commits, and the reason ends up in the merge commit.

**How does it decide a session is dead?**
By the age of the newest uncommitted file in the worktree (`--stale-hours`). It cannot see processes, so the plan lists stale worktrees as rescue candidates and live ones as "do not touch"; rescue itself is non-destructive either way.

**Why fast-forward the base instead of merging into it in place?**
The integration branch is built and tested away from everyone's working trees. Landing is then a single ref move plus a careful update of the one worktree that has the base checked out, which can be reasoned about path by path.

**What if the base moves while I am integrating?**
`land` refuses. Merge the new base commits into the integration branch, rerun the tests, and land with the new `--old`.

**Does it push, open pull requests or deploy?**
No. It works on local refs and worktrees only.

## Limitations

- Conflict prediction needs git 2.38+ (`merge-tree --write-tree`); with older git the map shows `?` and everything else still works.
- Session liveness is a heuristic based on file times.
- `land` merges collisions for modified text files only; files added or deleted on one side and binary files are left as they are and listed.
- Partial takes (some commits of a branch) are done by hand: cherry-pick them onto a new branch and take that branch.
- One base branch per repository per run.

## Roadmap

- `mergechaos status` to follow a run (what is merged, rescued, landed, still asking).
- Optional test command per repository in `plan.json`, run by `integrate` after the last merge.
- Remote awareness: report branches that exist only on a remote.

## License

[MIT](LICENSE)
