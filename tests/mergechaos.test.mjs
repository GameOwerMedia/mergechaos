// Tests for mergechaos on throwaway git repositories: branches, worktrees, stale sessions, a conflicting file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs, overlaps, verdict, order, statusEntries, worktreeState, inventory, makePlan, renderPlan, renderMap,
  integrate, rescue, land, archive, mergeIntoDisk, reportJson,
} from '../skills/mergechaos/scripts/mergechaos.mjs';
import { buildAcmeShop, gitIn, initRepo, write } from '../examples/acme-shop.mjs';

/** A fake credential, assembled at run time so secret scanners do not flag this file. */
const FAKE = JSON.stringify('abcdefghij' + 'klmnopqrstuvwxyz');
const CLI = fileURLToPath(new URL('../skills/mergechaos/scripts/mergechaos.mjs', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: { ...process.env, PREMERGE_REGISTRY: '' } });
const temp = () => mkdtempSync(join(tmpdir(), 'mergechaos-'));
const B = (name, extra = {}) => ({ name, last: '2026-01-01T00:00:00Z', conflicts: [], files: [], report: { why: 'w', current: true, status: 'ready', dependsOn: [] }, ...extra });

test('parseArgs: repeatable --repo and --branch, booleans, --key=value', () => {
  assert.deepEqual(parseArgs(['land', '--repo', 'a', '--repo=b,c', '--dry-run', '--branch', 'x,y', '--base', 'main']),
    { _: ['land'], repo: ['a', 'b', 'c'], 'dry-run': true, branch: ['x', 'y'], base: 'main' });
});

test('verdict: TAKE needs a current report with a why; everything else is ASK or ARCHIVE', () => {
  assert.equal(verdict(B('a')).verdict, 'TAKE');
  assert.equal(verdict(B('a', { report: null })).verdict, 'ASK');
  assert.equal(verdict(B('a', { report: { why: '', current: true } })).verdict, 'ASK');
  assert.equal(verdict(B('a', { report: { why: 'w', current: false } })).verdict, 'ASK');
  assert.equal(verdict(B('a', { report: { why: 'w', current: true, status: 'wip' } })).verdict, 'ASK');
  assert.equal(verdict(B('a', { report: { why: 'w', current: true, author: 'reconstructed' } })).verdict, 'ASK');
  assert.equal(verdict(B('a', { report: { why: 'w', current: true, dependsOn: ['z'] } })).verdict, 'ASK', 'dependency not taken');
  assert.equal(verdict(B('a', { report: { why: 'w', current: true, dependsOn: ['z'] } }), { taken: new Set(['z']) }).verdict, 'TAKE');
  assert.equal(verdict(B('rescue/x/2026-01-01', { rescue: true })).verdict, 'ARCHIVE');
  assert.equal(verdict(B('a', { alreadyInBase: true })).verdict, 'ARCHIVE');
  assert.match(verdict(B('a', { conflicts: ['f.js'] })).reason, /resolve 1 conflict/);
});

test('order: dependencies first, then clean merges before conflicting ones', () => {
  const list = [B('c', { conflicts: ['x'] }), B('b', { report: { why: 'w', current: true, dependsOn: ['a'] } }), B('a', { last: '2026-02-01T00:00:00Z' })];
  assert.deepEqual(order(list).map(b => b.name), ['a', 'b', 'c']);
});

test('overlaps: files changed by two or more branches', () => {
  assert.deepEqual(overlaps([{ name: 'a', files: ['x', 'y'] }, { name: 'b', files: ['y'] }, { name: 'c', files: ['y', 'z'] }]), [{ file: 'y', branches: ['a', 'b', 'c'] }]);
});

test('mergeIntoDisk: clean three-way merge keeps the CRLF of the disk copy; a conflict leaves the file untouched', () => {
  const d = temp();
  try {
    const f = join(d, 'f.txt');
    writeFileSync(f, 'one\r\ntwo\r\nthree\r\nmine\r\n');
    assert.deepEqual(mergeIntoDisk(f, 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n'), { ok: true, eol: 'CRLF' });
    assert.equal(readFileSync(f, 'utf8'), 'ONE\r\ntwo\r\nthree\r\nmine\r\n');
    writeFileSync(f, 'uno\n');
    const r = mergeIntoDisk(f, 'one\n', 'ONE\n');
    assert.equal(r.ok, false); assert.equal(readFileSync(f, 'utf8'), 'uno\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('worktreeState and statusEntries: clean, live, stale by the age of the newest dirty file', () => {
  const d = temp();
  try {
    const g = initRepo(d); write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'a');
    assert.equal(worktreeState({ path: d }).state, 'clean');
    write(d, 'a.txt', 'b\n'); write(d, 'new/n.txt', 'n\n');
    assert.deepEqual(statusEntries(d).map(e => [e.xy, e.path]), [[' M', 'a.txt'], ['??', 'new/n.txt']]);
    assert.equal(worktreeState({ path: d }).state, 'live');
    assert.equal(worktreeState({ path: d }, { now: Date.now() + 48 * 36e5 }).state, 'stale');
    assert.equal(worktreeState({ path: join(d, 'gone') }).state, 'missing');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('end to end on acme-shop: inventory, plan, integrate with a conflict, rescue, land, archive', () => {
  const root = temp();
  try {
    const { dir, wtC, g } = buildAcmeShop(root);
    // inventory
    const map = inventory([dir, wtC], { days: 30, staleHours: 24 });
    assert.equal(map.repos.length, 1, 'the linked worktree counts once, with its main repository');
    const r = map.repos[0], by = Object.fromEntries(r.branches.map(b => [b.name, b]));
    assert.deepEqual(Object.keys(by).sort(), ['agent-a/cart', 'agent-b/checkout', 'agent-c/theme', 'agent-d/typo']);
    assert.equal(by['agent-a/cart'].report.why, 'Customers must see the real cart total before checkout.');
    assert.ok(by['agent-a/cart'].report.current, 'report commit after the head does not make it stale');
    assert.equal(by['agent-c/theme'].report, null);
    assert.ok(by['agent-d/typo'].alreadyInBase);
    assert.deepEqual(r.overlaps.find(o => o.file === 'src/shared.js').branches.sort(), ['agent-b/checkout', 'agent-c/theme']);
    assert.deepEqual(r.pairConflicts, [{ branches: ['agent-b/checkout', 'agent-c/theme'], files: ['src/shared.js'] }], 'conflict between two branches predicted before any merge');
    const wc = r.worktrees.find(w => w.branch === 'agent-c/theme');
    assert.equal(wc.state, 'stale'); assert.equal(wc.dirty, 4);
    assert.equal(r.worktrees.find(w => w.main).state, 'live');
    assert.match(renderMap(map), /\*\*missing\*\*/);

    // plan
    const plan = makePlan(map, { at: new Date('2026-01-02T03:04:00Z') });
    const v = Object.fromEntries(plan.repos[0].steps.map(s => [s.branch, s.verdict]));
    assert.deepEqual(v, { 'agent-a/cart': 'TAKE', 'agent-b/checkout': 'TAKE', 'agent-c/theme': 'ASK', 'agent-d/typo': 'ARCHIVE' });
    const steps = plan.repos[0].steps.map(s => s.branch);
    assert.ok(steps.indexOf('agent-a/cart') < steps.indexOf('agent-b/checkout'), 'dependency first');
    assert.equal(plan.repos[0].rescue.length, 1); assert.equal(plan.repos[0].live.length, 1);
    assert.match(renderPlan(plan), /A \(recommended\): ask the author/);

    // the owner explains agent-c/theme, so it is taken too; it conflicts with agent-b/checkout in src/shared.js
    const theme = plan.repos[0].steps.find(s => s.branch === 'agent-c/theme');
    Object.assign(theme, { verdict: 'TAKE', reason: 'Owner: the UK store launches with the dark theme.' });
    plan.repos[0].steps = [...plan.repos[0].steps.filter(s => s !== theme), theme];
    const runDir = join(root, 'run');
    const first = integrate(plan, { runDir })[0];
    assert.deepEqual(first.merged, ['agent-a/cart', 'agent-b/checkout']);
    assert.match(first.stopped, /conflict merging agent-c\/theme/); assert.deepEqual(first.conflicts, ['src/shared.js']);
    const wt = first.worktree, gw = gitIn(wt);
    write(wt, 'src/shared.js', "export const currency = 'USD';\nexport const locale = 'en';\nexport const theme = 'dark';\n");
    gw('add', 'src/shared.js'); gw('commit', '-q', '--no-edit');
    const second = integrate(plan, { runDir })[0];
    assert.equal(second.stopped, null); assert.deepEqual(second.skipped, ['agent-a/cart', 'agent-b/checkout', 'agent-c/theme'], 'the resolved merge counts as done'); assert.deepEqual(second.merged, []);
    assert.equal(g('rev-parse', 'main'), plan.repos[0].baseTip, 'integrate never moves the base');

    // rescue the stale session: branch with its work, worktree untouched, .env left out
    const gc = gitIn(wtC), before = gc('status', '--porcelain');
    const res = rescue({ worktree: wtC, now: new Date('2026-01-02T00:00:00Z') });
    assert.equal(res.branch, 'rescue/acme-shop-theme/2026-01-02');
    assert.deepEqual(res.committed.sort(), ['notes/scratch.md', 'src/cart.js', 'src/theme.css']);
    assert.deepEqual(res.left.map(x => [x.path, x.why]), [ ['.env', 'private file'] ]);
    assert.equal(gc('status', '--porcelain'), before, 'worktree and its index unchanged');
    assert.equal(gc('show', `${res.branch}:src/theme.css`), ':root { --bg: #111; --fg: #eee; }');
    assert.match(gc('show', `${res.branch}:.mergechaos/RESCUE.md`), /\.env.*private file/);
    assert.equal(spawnSync('git', ['cat-file', '-e', `${res.branch}:.env`], { cwd: wtC }).status, 128, '.env not committed');

    // land: main is checked out in the main worktree, where a live session edits src/cart.js
    const dry = land({ repo: dir, base: 'main', oldRef: plan.repos[0].baseTip, newRef: second.branch, dryRun: true });
    assert.deepEqual(Object.fromEntries(dry.table.map(t => [t.path, t.kind])),
      { 'docs/premerge/agent-a_cart.md': 'SAFE', 'docs/premerge/agent-b_checkout.md': 'SAFE', 'src/cart.js': 'COLLIDE', 'src/checkout.js': 'SAFE', 'src/shared.js': 'SAFE' });
    assert.equal(g('rev-parse', 'main'), plan.repos[0].baseTip, 'dry run moves nothing');
    const landed = land({ repo: dir, base: 'main', oldRef: plan.repos[0].baseTip, newRef: second.branch });
    assert.equal(g('rev-parse', 'main'), second.tip);
    assert.deepEqual(landed.unresolved, []);
    assert.equal(readFileSync(join(dir, 'src/cart.js'), 'utf8'), 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n\nexport const freeShippingFrom = 50;\n', 'base change merged into the live edit');
    assert.equal(g('status', '--porcelain'), ' M src/cart.js', 'only the live edit remains uncommitted');
    assert.equal(g('diff', '--cached', '--name-only'), '');
    const stale = land({ repo: dir, base: 'main', oldRef: plan.repos[0].baseTip, newRef: second.branch });
    assert.match(stale.stopped, /moved since the plan/);

    // archive the rescue branch and the ARCHIVE verdict
    const a = archive(dir, [res.branch, 'agent-d/typo', 'agent-c/theme']);
    assert.equal(a[0].tag, `archive/${res.branch}`); assert.ok(a[0].removed);
    assert.equal(a[1].tag, 'archive/agent-d/typo');
    assert.match(a[2].skipped, /checked out/);
    assert.equal(g('rev-parse', `archive/${res.branch}^{commit}`), res.commit);
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${res.branch}`], { cwd: dir }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land: SAFE writes and deletes, EQUAL skips, a conflicting COLLIDE is left exactly as it was (exit 7)', () => {
  const d = temp();
  try {
    const g = initRepo(d);
    for (const f of ['a', 'b', 'c', 'd', 'e']) write(d, `${f}.txt`, `${f}1\n${f}2\n${f}3\n`);
    g('add', '.'); g('commit', '-q', '-m', 'base');
    const OLD = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'merge/x');
    for (const f of ['a', 'b', 'c', 'd']) write(d, `${f}.txt`, `${f.toUpperCase()}1\n${f}2\n${f}3\n`);
    g('rm', '-q', 'e.txt'); g('add', '.'); g('commit', '-q', '-m', 'integration');
    g('checkout', '-q', 'main');
    write(d, 'b.txt', 'B1\nb2\nb3\n');            // disk already has the new content
    write(d, 'c.txt', 'c1\nc2\nc3 mine\n');       // someone's edit, mergeable
    write(d, 'd.txt', 'd1 mine\nd2\nd3\n');       // someone's edit on the same line: conflict
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x');
    assert.equal(out.status, 7, out.stderr + out.stdout);
    assert.match(out.stdout, /EQUAL 1, SAFE 2, COLLIDE 2/);
    assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'A1\na2\na3\n');
    assert.ok(!existsSync(join(d, 'e.txt')));
    assert.equal(readFileSync(join(d, 'c.txt'), 'utf8'), 'C1\nc2\nc3 mine\n');
    assert.equal(readFileSync(join(d, 'd.txt'), 'utf8'), 'd1 mine\nd2\nd3\n');
    assert.equal(g('status', '--porcelain'), ' M c.txt\n M d.txt');
    assert.match(out.stdout, /Unresolved collisions .*d\.txt/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('land refuses when something is staged in the shared index; base not checked out = ref only', () => {
  const d = temp();
  try {
    const g = initRepo(d);
    write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    const OLD = g('rev-parse', 'HEAD');
    g('branch', 'merge/x'); g('checkout', '-q', 'merge/x'); write(d, 'b.txt', 'b\n'); g('add', '.'); g('commit', '-q', '-m', 'b');
    g('checkout', '-q', 'main');
    write(d, 'a.txt', 'staged\n'); g('add', 'a.txt');
    assert.match(land({ repo: d, base: 'main', oldRef: OLD, newRef: 'merge/x' }).stopped, /staged/);
    g('reset', '-q');
    g('checkout', '-q', '--detach');
    const r = land({ repo: d, base: 'main', oldRef: OLD, newRef: 'merge/x' });
    assert.equal(r.worktree, null); assert.equal(g('rev-parse', 'main'), g('rev-parse', 'merge/x'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rescue: large files and possible secrets stay out and are listed by size and hash, never by content', () => {
  const d = temp();
  try {
    const g = initRepo(d);
    write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    write(d, 'big.bin', Buffer.alloc(1200000, 1));
    write(d, 'conf.js', 'const apiKey = ' + FAKE + ';\n');
    write(d, 'ok.txt', 'fine\n');
    rmSync(join(d, 'a.txt'));
    const r = rescue({ worktree: d, name: 'rescue/test' });
    assert.deepEqual(r.committed.sort(), ['a.txt', 'ok.txt']);
    assert.deepEqual(r.left.map(x => [x.path, x.why.split(' (')[0]]), [['big.bin', 'larger than 1 MB'], ['conf.js', 'possible secret']]);
    const manifest = g('show', 'rescue/test:.mergechaos/RESCUE.md');
    assert.ok(!manifest.includes(JSON.parse(FAKE)), 'no secret value in the manifest');
    assert.match(manifest, /big\.bin.*1200000.*`[0-9a-f]{64}`/);
    assert.equal(spawnSync('git', ['cat-file', '-e', 'rescue/test:a.txt'], { cwd: d }).status, 128, 'the deletion is rescued too');
    assert.ok(!existsSync(join(d, 'a.txt')), 'disk unchanged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('CLI: inventory and plan write MAP.md, map.json, PLAN.md and plan.json into the run folder', () => {
  const root = temp();
  try {
    const { dir } = buildAcmeShop(root);
    const runDir = join(root, 'run');
    const inv = run('inventory', '--repo', dir, '--out', runDir, '--json');
    assert.equal(inv.status, 0, inv.stderr);
    assert.deepEqual(JSON.parse(inv.stdout).branches, 4);
    const pl = run('plan', '--run', runDir);
    assert.equal(pl.status, 0, pl.stderr); assert.match(pl.stdout, /TAKE 2, ASK 1, ARCHIVE 1/);
    for (const f of ['MAP.md', 'map.json', 'PLAN.md', 'plan.json']) assert.ok(existsSync(join(runDir, f)), f);
    const ig = run('integrate', '--run', runDir);
    assert.equal(ig.status, 0, ig.stderr + ig.stdout); assert.match(ig.stdout, /2 merged/);
    assert.equal(reportJson('```premerge-json\n{"why":"x"}\n```').why, 'x');
    assert.equal(run('land', '--repo', dir).status, 2, 'usage error without --base/--old/--new');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
