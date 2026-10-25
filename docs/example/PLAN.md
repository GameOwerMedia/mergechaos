# Merge plan <stamp>

Draft by mergechaos 0.1.0 from the map of <time>. Verdicts: TAKE 2, ASK 1, ARCHIVE 1.

This is a draft. Read every premerge report, then edit `plan.json` (verdict and reason) before `integrate`. Change ASK to TAKE only when you can say, in one sentence, why the branch exists. Nothing in this plan touches a base branch until `land` runs with the owner's go-ahead.

## acme-shop

Base `main` at `912e2d1876`; integration branch `merge/<stamp>` in a separate worktree.

| Order | Branch | Verdict | Reason | Conflicts |
|---:|---|---|---|---|
| 1 | `agent-a/cart` | **TAKE** | Customers must see the real cart total before checkout. | none |
| 2 | `agent-b/checkout` | **TAKE** | The checkout page shows the order summary; the shop now sells in USD. | with `agent-c/theme`: `src/shared.js` |
| 3 | `agent-d/typo` | **ARCHIVE** | Every commit is already in the base under another hash (git cherry); nothing left to merge. | none |
| 4 | `agent-c/theme` | **ASK** | No premerge report: the purpose of this branch is unknown. Ask its author to write one. | with `agent-b/checkout`: `src/shared.js` |

**Stale sessions with uncommitted work (rescue before landing):**
- `~/work/acme-shop-theme` on `agent-c/theme`: 4 change(s), last edit <time>. `mergechaos rescue --repo "~/work/acme-shop" --worktree "~/work/acme-shop-theme"`

**Live sessions (report only, do not touch; the owner commits and writes a premerge report):**
- `~/work/acme-shop` on `main`: 1 change(s)

**Questions (blocking only for their own branch):**

1. `agent-c/theme`: No premerge report: the purpose of this branch is unknown. Ask its author to write one.
   - A (recommended): ask the author for a premerge report (`premerge report --why "..." --commit`), then re-run `inventory` and `plan`.
   - B: take it as it is. Only if you can state its purpose yourself; write that purpose into plan.json.
   - C: archive it (tag `archive/<branch>`, nothing is lost).

## Next commands

```
mergechaos integrate --run "~/work/runs/demo"
# run the tests every report lists inside the integration worktree, review the result, then, with the owner's go-ahead:
mergechaos land --repo "~/work/acme-shop" --base main --old 912e2d1876e76987042ec7a6e71a120e703db27a --new merge/<stamp>
mergechaos archive --repo "~/work/acme-shop" --branch agent-d/typo,<rescue branches created above>
```
