# plan.json and the files mergechaos reads

## Run folder

| File | Written by | Purpose |
|---|---|---|
| `map.json`, `MAP.md` | `inventory` | Facts from git. Never edited by hand. |
| `plan.json`, `PLAN.md` | `plan` | The draft plan. `plan.json` is what `integrate` executes; edit it after review. `PLAN.md` is the readable copy of the draft. |
| `integrate.json` | `integrate` | Result per repository: merged, skipped (already in), where it stopped and why. |
| `wt/<repo>/` | `integrate` | The integration worktree with branch `merge/<stamp>`. |

## plan.json (schema 1)

```json
{
  "schema": 1,
  "stamp": "2026-01-02-03-04",
  "repos": [{
    "name": "acme-shop",
    "path": "/work/acme-shop",
    "base": "main",
    "baseTip": "<full sha of the base when the plan was made>",
    "integration": "merge/2026-01-02-03-04",
    "steps": [
      { "branch": "agent-a/cart", "head": "<full sha>", "verdict": "TAKE", "reason": "Customers must see the real cart total.",
        "conflicts": [], "conflictsWith": [], "author": "agent-a", "worktree": null }
    ],
    "rescue": [{ "worktree": "/work/acme-shop-theme", "branch": "agent-c/theme", "dirty": 4, "lastEdit": "..." }],
    "live": [{ "worktree": "/work/acme-shop", "branch": "main", "dirty": 1 }],
    "prune": []
  }]
}
```

Editing rules:
- `steps` are executed in array order. Keep dependencies before the branches that need them.
- `verdict` is `TAKE`, `ASK` or `ARCHIVE`. Only `TAKE` steps are merged.
- Set `TAKE` only with a `reason` that states the purpose in one sentence. The reason becomes part of the merge commit message.
- `head` pins the commit that was reviewed. If the branch moves, `integrate` stops; run `inventory` and `plan` again.
- `baseTip` is the `--old` value for `land`.

## Reports from premerge

mergechaos looks for a report of each branch in two places and prefers the current one:
1. On the branch: `docs/premerge/<slug>.md`, where `<slug>` replaces every character outside `A-Z a-z 0-9 . _ -` with `_`.
2. In a registry: `<git common dir>/premerge/registry.jsonl`, and `$PREMERGE_REGISTRY/registry.jsonl` when that variable is set.

From the report's fenced `premerge-json` block it reads `why`, `author`, `status`, `dependsOn`, `head`, `partial` and `hotFiles`. A report is current when `head` is an ancestor of the branch and every later commit only touches `docs/premerge/`. Any other writer can produce compatible reports by emitting that block.
