# Contributing

Thank you for helping. mergechaos is small on purpose: one dependency-free script, one skill file, tests on throwaway repositories.

- **Run the tests** before a pull request: `npm test` (Node.js 18+ and git 2.38+ on your PATH; no install step).
- **Keep it dependency-free.** The script must run from a copied skill folder with nothing but Node.js and git.
- **Never touch a working tree you did not create.** New behaviour that writes to git must go through temporary indexes, new refs or a dedicated worktree, and needs a test that proves the user's working tree and index are unchanged.
- **Tests use temporary repositories** created under the system temp folder and removed afterwards. Do not depend on the developer's git configuration; set identity and `core.autocrlf` locally in the test repository.
- **Style:** plain modern JavaScript (ES modules), short functions with a one-line comment that says why, English everywhere.
- **Commits:** one logical change per commit, imperative subject line.

Bug reports are most useful with the exact command, the output, `git --version`, `node --version` and the operating system.
