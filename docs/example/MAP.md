# Merge chaos map

Generated <time> by mergechaos 0.1.0. Facts from git only. Window: branches with commits in the last 30 days; a worktree is stale after 24 h without edits.

Repositories: 1. Unmerged branches: 4. Without a current premerge report: 2.

| Chaos | Repository | Base | Branches (no current report) | Overlapping files | Uncommitted | Worktrees (stale) |
|---:|---|---|---|---:|---:|---|
| 22 | `acme-shop` | `main` | 4 (2) | 2 | 5 | 2 (1) |

## acme-shop

- Path: `~/work/acme-shop`
- Base `main` at `0f96904ec0`; no production branch

| Worktree | Branch | State | Uncommitted | Last edit | By folder |
|---|---|---|---:|---|---|
| `~/work/acme-shop` (main) | `main` | live | 1 | <time> | `src/` 1M/0? |
| `~/work/acme-shop-theme` | `agent-c/theme` | stale | 4 | <time> | `src/` 1M/1?, `.env` 0M/1?, `notes/` 0M/1? |

| Branch | Last commit | Ahead/behind | Predicted conflicts | Premerge report (why) |
|---|---|---|---|---|
| `agent-b/checkout` | <time> | 4/2 | none | The checkout page shows the order summary; the shop now sells in USD. |
| `agent-c/theme` | <time> | 1/0 | none | **missing** |
| `agent-d/typo` (already in base) | <time> | 1/2 | none | **missing** |
| `agent-a/cart` | <time> | 2/2 | none | Customers must see the real cart total before checkout. |

**Files changed by several branches:**
- `src/cart.js`: `agent-b/checkout`, `agent-a/cart`
- `src/shared.js`: `agent-b/checkout`, `agent-c/theme`

**Predicted conflicts between branches** (git merge-tree):
- `agent-b/checkout` and `agent-c/theme`: `src/shared.js`

<details><summary><code>agent-b/checkout</code>: 4 commit(s)</summary>

- `b71dd6e` <time> docs(premerge): report for agent-b/checkout (1 files)
- `b758a79` <time> Checkout summary in USD (2 files)
- `b810659` <time> docs(premerge): report for agent-a/cart (1 files)
- `01549cb` <time> Cart total from price and quantity (1 files)

</details>

<details><summary><code>agent-c/theme</code>: 1 commit(s)</summary>

- `9bdb9cd` <time> Dark theme for the UK store (1 files)

</details>

<details><summary><code>agent-d/typo</code>: 1 commit(s)</summary>

- `69c0634` <time> Fix the shop title typo (1 files)

</details>

<details><summary><code>agent-a/cart</code>: 2 commit(s)</summary>

- `b810659` <time> docs(premerge): report for agent-a/cart (1 files)
- `01549cb` <time> Cart total from price and quantity (1 files)

</details>
