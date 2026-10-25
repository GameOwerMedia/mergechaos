# Merge chaos map

Generated 2026-10-25T11:08:27.448Z by mergechaos 0.1.0. Facts from git only. Window: branches with commits in the last 30 days; a worktree is stale after 24 h without edits.

Repositories: 1. Unmerged branches: 4. Without a current premerge report: 2.

| Chaos | Repository | Base | Branches (no current report) | Overlapping files | Uncommitted | Worktrees (stale) |
|---:|---|---|---|---:|---:|---|
| 22 | `acme-shop` | `main` | 4 (2) | 2 | 5 | 2 (1) |

## acme-shop

- Path: `~/work/acme-shop`
- Base `main` at `e0646dfe67`; no production branch

| Worktree | Branch | State | Uncommitted | Last edit | By folder |
|---|---|---|---:|---|---|
| `~/work/acme-shop` (main) | `main` | live | 1 | 2026-10-25 11:08 | `src/` 1M/0? |
| `~/work/acme-shop-theme` | `agent-c/theme` | stale | 4 | 2026-10-24 09:08 | `src/` 1M/1?, `.env` 0M/1?, `notes/` 0M/1? |

| Branch | Last commit | Ahead/behind | Predicted conflicts | Premerge report (why) |
|---|---|---|---|---|
| `agent-c/theme` | 2026-10-25 11:08 | 1/0 | none | **missing** |
| `agent-b/checkout` | 2026-10-25 11:08 | 4/2 | none | The checkout page shows the order summary; the shop now sells in USD. |
| `agent-d/typo` (already in base) | 2026-10-25 11:08 | 1/2 | none | **missing** |
| `agent-a/cart` | 2026-10-25 11:08 | 2/2 | none | Customers must see the real cart total before checkout. |

**Files changed by several branches:**
- `src/shared.js`: `agent-c/theme`, `agent-b/checkout`
- `src/cart.js`: `agent-b/checkout`, `agent-a/cart`

**Predicted conflicts between branches** (git merge-tree):
- `agent-b/checkout` and `agent-c/theme`: `src/shared.js`

<details><summary><code>agent-c/theme</code>: 1 commit(s)</summary>

- `51476c6` 2026-10-25 11:08 Dark theme for the UK store (1 files)

</details>

<details><summary><code>agent-b/checkout</code>: 4 commit(s)</summary>

- `c17e982` 2026-10-25 11:08 docs(premerge): report for agent-b/checkout (1 files)
- `e2e3b5c` 2026-10-25 11:08 Checkout summary in USD (2 files)
- `91c6891` 2026-10-25 11:08 docs(premerge): report for agent-a/cart (1 files)
- `f692f49` 2026-10-25 11:08 Cart total from price and quantity (1 files)

</details>

<details><summary><code>agent-d/typo</code>: 1 commit(s)</summary>

- `57c4f73` 2026-10-25 11:08 Fix the shop title typo (1 files)

</details>

<details><summary><code>agent-a/cart</code>: 2 commit(s)</summary>

- `91c6891` 2026-10-25 11:08 docs(premerge): report for agent-a/cart (1 files)
- `f692f49` 2026-10-25 11:08 Cart total from price and quantity (1 files)

</details>
