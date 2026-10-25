#!/usr/bin/env node
// Demo: the full mergechaos flow on a throwaway "acme-shop" left behind by four agents.
//   node examples/demo.mjs [--keep] [--write-docs]
// Uses the real premerge writer when it is found (PREMERGE_SCRIPT, or a sibling checkout ../premerge);
// otherwise writes minimal reports in the same format. --write-docs refreshes docs/example/.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcmeShop } from './acme-shop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'skills', 'mergechaos', 'scripts', 'mergechaos.mjs');
const keep = process.argv.includes('--keep'), writeDocs = process.argv.includes('--write-docs');
const sibling = path.join(here, '..', '..', 'premerge', 'skills', 'premerge', 'scripts', 'premerge.mjs');
const premerge = process.env.PREMERGE_SCRIPT || (existsSync(sibling) ? sibling : null);
const root = mkdtempSync(path.join(tmpdir(), 'mergechaos-demo-'));
const runDir = path.join(root, 'runs', 'demo');
/** Neutral output: temp paths become ~/work, run stamps and clock times become placeholders. */
const hide = s => String(s).split(root).join('~/work').split(root.replace(/\\/g, '/')).join('~/work').replace(/\\/g, '/')
  .replace(/\b\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\b/g, '<stamp>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
  .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<time>')
  .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
const transcript = [];
const note = t => { transcript.push(`# ${t}`); console.log(`\n# ${t}`); };
function mc(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, PREMERGE_REGISTRY: '' } });
  const shown = hide(args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')), out = hide((r.stdout + r.stderr).trim());
  transcript.push(`$ mergechaos ${shown}`, out, `(exit ${r.status})`, '');
  console.log(`$ mergechaos ${shown}\n${out}\n(exit ${r.status})`);
  return r;
}

const { dir, wtC } = buildAcmeShop(root, { premerge });
console.log(`acme-shop built with ${premerge ? 'real premerge reports' : 'minimal premerge reports'}`);

note('1. Inventory: facts from git, no model');
mc('inventory', '--repo', dir, '--out', runDir);
note('2. Draft plan: TAKE only with a current report that says why');
mc('plan', '--run', runDir);
const planFile = path.join(runDir, 'plan.json'), plan = JSON.parse(readFileSync(planFile, 'utf8'));
const mapMd = readFileSync(path.join(runDir, 'MAP.md'), 'utf8'), planMd = readFileSync(path.join(runDir, 'PLAN.md'), 'utf8');

note('3. The owner answers the ASK: agent-c/theme is the UK launch theme, take it (plan.json edited)');
const theme = plan.repos[0].steps.find(s => s.branch === 'agent-c/theme');
Object.assign(theme, { verdict: 'TAKE', reason: 'Owner: the UK store launches with the dark theme; keep USD from agent-b/checkout.' });
plan.repos[0].steps = [...plan.repos[0].steps.filter(s => s !== theme), theme];
writeFileSync(planFile, JSON.stringify(plan, null, 1));

note('4. Integrate in dependency order inside a separate worktree');
mc('integrate', '--run', runDir);
const wt = path.join(runDir, 'wt', 'acme-shop');
note('   Resolve src/shared.js keeping both sides (USD from agent-b, dark theme from agent-c), commit, run again');
writeFileSync(path.join(wt, 'src', 'shared.js'), "export const currency = 'USD';\nexport const locale = 'en';\nexport const theme = 'dark';\n");
execFileSync('git', ['add', 'src/shared.js'], { cwd: wt }); execFileSync('git', ['commit', '-q', '--no-edit'], { cwd: wt });
mc('integrate', '--run', runDir);

note('5. Rescue the stale session of agent-c (its worktree stays exactly as it is)');
const rescued = { branch: mc('rescue', '--worktree', wtC).stdout.match(/ to (\S+) at /)[1] };
note('6. Land: main moves to the tested merge commit; a live session is editing src/cart.js in the main worktree');
const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
const landArgs = ['land', '--repo', dir, '--base', 'main', '--old', plan.repos[0].baseTip, '--new', plan.repos[0].integration];
mc(...landArgs, '--dry-run');
note('   By default a collision refuses the whole landing: nothing is written, main does not move');
mc(...landArgs);
note('   The owner agrees to land now: --allow-collisions writes the SAFE paths and merges the base change into the edit');
mc(...landArgs, '--allow-collisions');
note('7. Archive the rescue branch and the ARCHIVE verdicts (annotated tags keep their commits reachable)');
mc('archive', '--repo', dir, '--branch', `${rescued.branch},agent-d/typo`);
console.log(`\nmain is now ${tip.slice(0, 10)}; uncommitted in the main worktree:\n${execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' })}`);

if (writeDocs) {
  const docs = path.join(here, '..', 'docs', 'example');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, 'MAP.md'), hide(mapMd));
  writeFileSync(path.join(docs, 'PLAN.md'), hide(planMd));
  writeFileSync(path.join(docs, 'transcript.txt'), transcript.join('\n'));
  console.log('Wrote docs/example/MAP.md, PLAN.md and transcript.txt');
}
execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir });
if (keep) console.log(`Kept: ${root}`); else rmSync(root, { recursive: true, force: true });
