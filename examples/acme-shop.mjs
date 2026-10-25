// Builds a throwaway "acme-shop" repository in the state many parallel agents leave behind:
//   agent-a/cart       finished, with a current premerge report
//   agent-b/checkout   finished, report says it depends on agent-a/cart; touches src/shared.js
//   agent-c/theme      no report, worked in its own worktree, touches src/shared.js too, and that
//                      worktree still holds uncommitted edits from a session that stopped a day ago
//   agent-d/typo       its only commit was already cherry-picked onto main
// Used by the tests and by examples/demo.mjs. Reports are written in the premerge format; when a premerge
// script is given (option `premerge`), the real tool writes them instead.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY = 864e5;

export function gitIn(dir) {
  return (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\s+$/, '');
}

export function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const g = gitIn(dir);
  g('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'agent@example.com'], ['user.name', 'Demo Agent'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) g('config', k, v);
  return g;
}

export function write(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

/** Minimal premerge report (the JSON block is the contract mergechaos reads). */
export function minimalReport({ repo, branch, base = 'main', head, why, author, status = 'ready', dependsOn = [], files = [] }) {
  const json = { schema: 1, tool: 'fixture', repo, branch, base, head, why, author, status, dependsOn, files, at: new Date().toISOString() };
  return `# Premerge: \`${branch}\`\n\n- **Why:** ${why}\n- **Author:** ${author}\n- **Status:** ${status}\n\n\`\`\`premerge-json\n${JSON.stringify(json)}\n\`\`\`\n`;
}

/** Writes and commits a report on the branch that is checked out in `dir`. */
export function commitReport(dir, { repo, branch, why, author, status, dependsOn, premerge }) {
  const g = gitIn(dir);
  if (premerge) {
    const args = [premerge, 'report', '--repo', dir, '--branch', branch, '--base', 'main', '--why', why, '--author', author, '--status', status || 'ready', '--commit', '--no-registry'];
    if (dependsOn?.length) args.push('--depends-on', dependsOn.join(','));
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`premerge failed: ${r.stderr}`);
    return;
  }
  const head = g('rev-parse', '--short=10', 'HEAD');
  const files = g('diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean);
  write(dir, `docs/premerge/${branch.replace(/[^A-Za-z0-9._-]+/g, '_')}.md`, minimalReport({ repo, branch, head, why, author, status, dependsOn, files }));
  g('add', 'docs/premerge'); g('commit', '-q', '-m', `docs(premerge): report for ${branch}`);
}

export function buildAcmeShop(root, { premerge = null, staleHours = 24 } = {}) {
  const dir = path.join(root, 'acme-shop'), wtC = path.join(root, 'acme-shop-theme');
  const g = initRepo(dir);
  write(dir, 'README.md', '# acme-shop\n\nA tiny shop used to demonstrate merging work from many agents.\n');
  write(dir, 'src/cart.js', 'export function total(items) {\n  return 0;\n}\n');
  write(dir, 'src/shared.js', "export const currency = 'EUR';\nexport const locale = 'en';\nexport const theme = 'light';\n");
  write(dir, 'src/copy.js', "export const title = 'Acme Shpo';\n");
  g('add', '.'); g('commit', '-q', '-m', 'Initial shop');

  // agent-a: cart total, report current
  g('checkout', '-q', '-b', 'agent-a/cart');
  write(dir, 'src/cart.js', 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n');
  g('commit', '-q', '-am', 'Cart total from price and quantity');
  commitReport(dir, { repo: 'acme-shop', branch: 'agent-a/cart', why: 'Customers must see the real cart total before checkout.', author: 'agent-a', premerge });

  // agent-b: checkout, depends on the cart total, also changes the shared currency line
  g('checkout', '-q', '-b', 'agent-b/checkout', 'agent-a/cart');
  write(dir, 'src/checkout.js', "import { total } from './cart.js';\nexport const summary = items => `Total: ${total(items)}`;\n");
  write(dir, 'src/shared.js', "export const currency = 'USD';\nexport const locale = 'en';\nexport const theme = 'light';\n");
  g('add', '.'); g('commit', '-q', '-m', 'Checkout summary in USD');
  commitReport(dir, { repo: 'acme-shop', branch: 'agent-b/checkout', why: 'The checkout page shows the order summary; the shop now sells in USD.', author: 'agent-b', dependsOn: ['agent-a/cart'], premerge });

  // agent-d: a typo fix that was cherry-picked onto main later
  g('checkout', '-q', '-b', 'agent-d/typo', 'main');
  write(dir, 'src/copy.js', "export const title = 'Acme Shop';\n");
  g('commit', '-q', '-am', 'Fix the shop title typo');
  const typo = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  write(dir, 'README.md', '# acme-shop\n\nA tiny shop used to demonstrate merging work from many agents.\n\nRun `npm test` before opening a pull request.\n');
  g('commit', '-q', '-am', 'Contributing note');
  g('cherry-pick', typo);

  // agent-c: own worktree, committed a theme change on the same shared line, no report; the session then stopped
  g('worktree', 'add', '-q', '-b', 'agent-c/theme', wtC, 'main');
  const gc = gitIn(wtC);
  write(wtC, 'src/shared.js', "export const currency = 'GBP';\nexport const locale = 'en';\nexport const theme = 'dark';\n");
  gc('commit', '-q', '-am', 'Dark theme for the UK store');
  write(wtC, 'src/theme.css', ':root { --bg: #111; --fg: #eee; }\n');
  write(wtC, 'src/cart.js', 'export function total(items) {\n  return 0; // TODO: dark mode badge\n}\n');
  write(wtC, '.env', 'PAYMENT_MODE=sandbox\n');
  write(wtC, 'notes/scratch.md', 'Half-finished idea: a contrast toggle in the header.\n');
  const old = new Date(Date.now() - (staleHours + 2) * 36e5);
  for (const f of ['src/theme.css', 'src/cart.js', '.env', 'notes/scratch.md']) utimesSync(path.join(wtC, f), old, old);

  // a live session in the main worktree (main checked out) is in the middle of an edit to the cart
  write(dir, 'src/cart.js', 'export function total(items) {\n  return 0;\n}\n\nexport const freeShippingFrom = 50;\n');

  return { dir, wtC, g, gc };
}

export { DAY };
