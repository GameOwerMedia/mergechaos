// Regression tests for the guards found by the second review: operations in progress in any worktree, a base checked
// out twice, case-only renames on case-insensitive filesystems, folder-to-file changes, submodule pointers, and rescue
// of huge files and of links that lead out of the worktree. Every test runs on throwaway repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archive, branchUse, land, rescue } from '../skills/mergechaos/scripts/mergechaos.mjs';
import { gitIn, initRepo, write } from '../examples/acme-shop.mjs';

const CLI = fileURLToPath(new URL('../skills/mergechaos/scripts/mergechaos.mjs', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: { ...process.env, PREMERGE_REGISTRY: '' } });
const temp = () => mkdtempSync(join(tmpdir(), 'mergechaos-'));
/** git that may fail (a rebase or cherry-pick that stops on a conflict); never opens an editor. */
const tryGit = (cwd, ...a) => spawnSync('git', ['-c', 'core.editor=true', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
const hasRef = (d, ref) => spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: d }).status === 0;

/** Commit on top of `parent` with `files` ({ path: text }) written straight into the object store; no working tree is touched. */
function commitOn(d, parent, files, msg = 'integration') {
  const idx = join(d, '.git', `test-${process.pid}.idx`), env = { ...process.env, GIT_INDEX_FILE: idx };
  const gi = (args, input) => execFileSync('git', args, { cwd: d, env, input, encoding: 'utf8' }).trim();
  try {
    gi(['read-tree', parent]);
    for (const [p, t] of Object.entries(files)) {
      const [mode, content] = Array.isArray(t) ? t : ['100644', t];
      const sha = mode === '160000' ? content : gi(['hash-object', '-w', '--stdin'], content);
      gi(['update-index', '--add', '--cacheinfo', `${mode},${sha},${p}`]);
    }
    return gi(['commit-tree', gi(['write-tree']), '-p', parent, '-m', msg]);
  } finally { rmSync(idx, { force: true }); }
}
/** main has f.txt changed against `topic`, so a rebase of topic onto main stops on a conflict. */
function conflicting(d) {
  const g = initRepo(d);
  write(d, 'f.txt', 'base\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
  g('branch', 'topic');
  write(d, 'f.txt', 'main\n'); g('commit', '-q', '-am', 'main change');
  return g;
}
/** A linked worktree on `branch`, outside the repository folder. */
function linked(root, g, branch) {
  const wt = join(root, `wt-${branch.replace(/\W/g, '_')}`);
  g('worktree', 'add', '-q', wt, branch);
  return { wt, gw: gitIn(wt) };
}
/** Three commits on main (OLD = the tip, checked out in the main worktree) and merge/x one commit ahead (adds other.txt). */
function landable(root) {
  const d = join(root, 'repo'), g = initRepo(d);
  for (const t of ['one', 'two', 'base']) { write(d, 'f.txt', `${t}\n`); g('add', '.'); g('commit', '-q', '-m', t); }
  const OLD = g('rev-parse', 'HEAD');
  g('update-ref', 'refs/heads/merge/x', commitOn(d, OLD, { 'other.txt': 'o\n' }));
  return { d, g, OLD };
}

test('archive skips a branch that is mid-rebase in a linked worktree (rebase-merge), and the rebase still finishes (N12)', () => {
  const root = temp();
  try {
    const d = join(root, 'repo'), g = conflicting(d);
    const { wt, gw } = linked(root, g, 'topic');
    write(wt, 'f.txt', 'topic\n'); gw('commit', '-q', '-am', 'topic change');
    const before = g('rev-parse', 'refs/heads/topic');
    assert.notEqual(tryGit(wt, 'rebase', '--merge', 'main').status, 0, 'the rebase stops on a conflict');
    assert.deepEqual(branchUse(d, 'topic').map(u => u.kind), ['rebase']);
    const out = run('archive', '--repo', d, '--branch', 'topic');
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /topic: skipped \(in use: a rebase of topic is in progress in .*finish or abort it first\)/);
    assert.equal(g('rev-parse', 'refs/heads/topic'), before, 'the branch ref is kept');
    assert.equal(g('tag', '-l'), '', 'no tag either');
    assert.match(archive(d, ['topic'], { keepBranch: true })[0].skipped, /rebase/, 'also with --keep-branch');
    write(wt, 'f.txt', 'resolved\n'); gw('add', 'f.txt');
    assert.equal(tryGit(wt, 'rebase', '--continue').status, 0, 'git can still finish the rebase');
    assert.equal(gw('rev-parse', '--abbrev-ref', 'HEAD'), 'topic');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('archive skips a branch under rebase --apply, under bisect, and checked out with a merge in progress', () => {
  const root = temp();
  try {
    const d = join(root, 'repo'), g = conflicting(d);
    g('branch', 'apply-me', 'topic');
    const a = linked(root, g, 'apply-me');
    write(a.wt, 'f.txt', 'apply\n'); a.gw('commit', '-q', '-am', 'apply change');
    assert.notEqual(tryGit(a.wt, 'rebase', '--apply', 'main').status, 0);
    const wtDir = readdirSync(join(d, '.git', 'worktrees')).find(n => n.includes('apply'));
    assert.ok(existsSync(join(d, '.git', 'worktrees', wtDir, 'rebase-apply', 'head-name')), 'git used rebase-apply');
    g('branch', 'bisect-me', 'main');
    const b = linked(root, g, 'bisect-me');
    b.gw('bisect', 'start'); b.gw('bisect', 'bad'); b.gw('bisect', 'good', 'topic');
    g('branch', 'merging', 'topic');
    const m = linked(root, g, 'merging');
    write(m.wt, 'f.txt', 'merging\n'); m.gw('commit', '-q', '-am', 'merging change');
    assert.notEqual(tryGit(m.wt, 'merge', 'main').status, 0);
    const r = Object.fromEntries(archive(d, ['apply-me', 'bisect-me', 'merging'], { keepBranch: true }).map(x => [x.branch, x.skipped || '']));
    assert.match(r['apply-me'], /a rebase of apply-me is in progress/);
    assert.match(r['bisect-me'], /a bisect started from bisect-me is in progress/);
    assert.match(r.merging, /merging is checked out in .* with a merge in progress/);
    for (const x of ['apply-me', 'bisect-me', 'merging']) assert.ok(hasRef(d, `refs/heads/${x}`), x);
    assert.equal(g('tag', '-l'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land refuses while the base is being rebased: the ref does not move and the rebase can finish (N11)', () => {
  const root = temp();
  try {
    const { d, g, OLD } = landable(root);
    g('checkout', '-q', '-b', 'feat', `${OLD}~1`); write(d, 'f.txt', 'feat\n'); g('commit', '-q', '-am', 'feat'); g('checkout', '-q', 'main');
    assert.notEqual(tryGit(d, 'rebase', 'feat').status, 0, 'the rebase of main stops on a conflict');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'HEAD is detached, so git worktree list shows no worktree on main');
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x');
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stderr, /STOP: a rebase of main is in progress in .*: finish or abort it, then run land again/);
    assert.equal(g('rev-parse', 'refs/heads/main'), OLD, 'main did not move');
    write(d, 'f.txt', 'resolved\n'); g('add', 'f.txt');
    assert.equal(tryGit(d, 'rebase', '--continue').status, 0, 'the rebase finishes normally');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land refuses when a bisect started from the base in another worktree, or a cherry-pick or revert is stopped where it is checked out', () => {
  const root = temp();
  try {
    const { d, g, OLD } = landable(root);
    g('checkout', '-q', '--detach');                     // the main worktree leaves main ...
    const b = linked(root, g, 'main');                    // ... and a linked worktree takes it
    b.gw('bisect', 'start'); b.gw('bisect', 'bad'); b.gw('bisect', 'good', `${OLD}~2`);
    let r = land({ repo: d, base: 'main', oldRef: OLD, newRef: 'merge/x' });
    assert.match(r.stopped, /a bisect started from main is in progress/);
    b.gw('bisect', 'reset');
    g('checkout', '-q', '-b', 'pick', OLD); write(d, 'f.txt', 'pick\n'); g('commit', '-q', '-am', 'pick');
    write(b.wt, 'f.txt', 'mine\n'); b.gw('commit', '-q', '-am', 'mine');
    const tip = b.gw('rev-parse', 'HEAD');
    g('update-ref', 'refs/heads/merge/x', commitOn(d, tip, { 'other.txt': 'o\n' }));
    assert.notEqual(tryGit(b.wt, 'cherry-pick', 'pick').status, 0);
    r = land({ repo: d, base: 'main', oldRef: tip, newRef: 'merge/x' });
    assert.match(r.stopped, /main is checked out in .* with a cherry-pick in progress/);
    assert.equal(tryGit(b.wt, 'cherry-pick', '--abort').status, 0);
    write(b.wt, 'f.txt', 'later\n'); b.gw('commit', '-q', '-am', 'later');
    const tip2 = b.gw('rev-parse', 'HEAD');
    g('update-ref', 'refs/heads/merge/x', commitOn(d, tip2, { 'other.txt': 'o\n' }));
    assert.notEqual(tryGit(b.wt, 'revert', '--no-edit', tip).status, 0);
    r = land({ repo: d, base: 'main', oldRef: tip2, newRef: 'merge/x' });
    assert.match(r.stopped, /with a revert in progress/);
    assert.equal(g('rev-parse', 'refs/heads/main'), tip2, 'main never moved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land refuses when the base is checked out in two worktrees, and touches neither (N7a)', () => {
  const root = temp();
  try {
    const { d, g, OLD } = landable(root);
    const second = join(root, 'second');
    g('worktree', 'add', '--force', '-q', second, 'main');
    write(second, 'f.txt', 'base\nEDIT IN SECOND\n');
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x');
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stderr, /main is checked out in 2 worktrees .*land updates exactly one working tree/);
    assert.equal(g('rev-parse', 'main'), OLD);
    assert.equal(gitIn(second)('status', '--porcelain'), ' M f.txt');
    assert.equal(g('status', '--porcelain'), '');
    assert.ok(!existsSync(join(d, 'other.txt')) && !existsSync(join(second, 'other.txt')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land: a case-only rename on a case-insensitive filesystem is refused, and never leaves the file missing (N2)', () => {
  const root = temp();
  try {
    const d = join(root, 'repo'), g = initRepo(d);
    const text = 'line1\nline2\nline3\n';
    write(d, 'Readme.md', text); write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    const OLD = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'merge/x'); g('mv', 'Readme.md', 'tmp.md'); g('mv', 'tmp.md', 'README.md'); write(d, 'a.txt', 'A\n');
    g('commit', '-q', '-am', 'rename'); g('checkout', '-q', 'main');
    g('config', 'core.ignorecase', 'true');      // what git sets on Windows and macOS; explicit, so the test runs everywhere
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x');
    assert.equal(out.status, 7, out.stdout + out.stderr);
    assert.match(out.stdout, /COLLIDE\tA\tREADME\.md \(differs only in letter case/);
    assert.match(out.stdout, /COLLIDE\tD\tReadme\.md \(differs only in letter case/);
    assert.equal(g('rev-parse', 'main'), OLD);
    assert.deepEqual(readdirSync(d).filter(x => /^readme/i.test(x)), ['Readme.md']);
    const allow = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x', '--allow-collisions');
    assert.equal(allow.status, 8, allow.stdout + allow.stderr);
    assert.equal(readFileSync(join(d, 'Readme.md'), 'utf8'), text, 'the file is still on disk');
    assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'A\n', 'the SAFE path landed');
    assert.equal(g('ls-files', '--', 'Readme.md', 'README.md'), 'Readme.md', 'index back at the old name');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land --allow-collisions: a folder that becomes a file never puts a folder into the index (N4)', () => {
  const root = temp();
  try {
    const d = join(root, 'repo'), g = initRepo(d);
    write(d, 'lib/a.js', 'a\n'); write(d, 'keep.txt', 'k\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    const OLD = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'merge/x'); g('rm', '-rq', 'lib'); write(d, 'lib', 'now a file\n'); g('add', '-A'); g('commit', '-q', '-m', 'dir to file');
    g('checkout', '-q', 'main');
    write(d, 'lib/mine.js', 'MY UNTRACKED WORK\n');
    assert.equal(run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x').status, 7);
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x', '--allow-collisions');
    assert.equal(out.status, 8, out.stdout + out.stderr);
    assert.equal(readFileSync(join(d, 'lib/mine.js'), 'utf8'), 'MY UNTRACKED WORK\n');
    const entries = g('ls-files', '-s').split('\n');
    assert.deepEqual(entries.map(l => l.split('\t')[1]), ['keep.txt'], 'no bogus entry such as "liba.js"');
    assert.ok(entries.every(l => !l.startsWith('040000')), 'no tree entry in the index');
    assert.equal(spawnSync('git', ['fsck', '--no-dangling'], { cwd: d }).status, 0);
    assert.match(g('status', '--porcelain'), /^D {2}lib$/m, 'the new file lib is shown as not checked out');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land: a submodule pointer bump is not a collision and never touches the nested repository', () => {
  const root = temp();
  try {
    const sub = join(root, 'sub'), gs = initRepo(sub);
    write(sub, 's.txt', 's1\n'); gs('add', '.'); gs('commit', '-q', '-m', 's1'); const s1 = gs('rev-parse', 'HEAD');
    write(sub, 's.txt', 's2\n'); gs('commit', '-q', '-am', 's2'); const s2 = gs('rev-parse', 'HEAD');
    const d = join(root, 'repo'), g = initRepo(d);
    write(d, 'a.txt', 'a\n'); g('add', '.');
    execFileSync('git', ['clone', '-q', sub, join(d, 'vendor', 'sub')]);
    const gn = gitIn(join(d, 'vendor', 'sub')); gn('checkout', '-q', s1);
    g('update-index', '--add', '--cacheinfo', `160000,${s1},vendor/sub`); g('commit', '-q', '-m', 'base');
    const OLD = g('rev-parse', 'HEAD');
    const NEW = commitOn(d, OLD, { 'vendor/sub': ['160000', s2], 'a.txt': 'a2\n' }, 'bump submodule');
    g('update-ref', 'refs/heads/merge/x', NEW);
    write(join(d, 'vendor', 'sub'), 'WIP.txt', 'MY WIP IN THE NESTED REPO\n');
    const nested = readFileSync(join(d, 'vendor', 'sub', 's.txt')), nestedStatus = gn('status', '--porcelain');
    const out = run('land', '--repo', d, '--base', 'main', '--old', OLD, '--new', 'merge/x');
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /SAFE\tM\tvendor\/sub \(submodule pointer only/);
    assert.equal(g('rev-parse', 'main'), NEW);
    assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'a2\n');
    assert.equal(gn('rev-parse', 'HEAD'), s1, 'the nested checkout did not move');
    assert.equal(readFileSync(join(d, 'vendor', 'sub', 'WIP.txt'), 'utf8'), 'MY WIP IN THE NESTED REPO\n');
    assert.ok(readFileSync(join(d, 'vendor', 'sub', 's.txt')).equals(nested), 'nested files untouched');
    assert.equal(gn('status', '--porcelain'), nestedStatus);
    assert.match(g('ls-files', '-s', '--', 'vendor/sub'), new RegExp(`^160000 ${s2} `), 'the index records the new pointer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rescue: a file above the limit is skipped by its size without reading it whole, also above 2 GiB (R5)', () => {
  const d = temp();
  try {
    const g = initRepo(d);
    write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    write(d, 'small.txt', 'small\n');
    const big = join(d, 'big.bin'), size = 2 ** 31 + 4096;
    writeFileSync(big, ''); truncateSync(big, size);    // sparse where the filesystem supports it
    write(d, 'mid.bin', Buffer.alloc(1500000, 7));
    const r = rescue({ worktree: d, name: 'rescue/big' });
    assert.deepEqual(r.committed.sort(), ['small.txt']);
    const by = Object.fromEntries(r.left.map(x => [x.path, x]));
    assert.match(by['big.bin'].why, /larger than 1 MB \(not hashed: over 1 GiB\)/); assert.equal(by['big.bin'].size, size);
    assert.equal(by['big.bin'].sha256, null);
    assert.match(by['mid.bin'].sha256, /^[0-9a-f]{64}$/, 'files under 1 GiB are still hashed, in chunks');
    assert.match(g('show', 'rescue/big:.mergechaos/RESCUE.md'), new RegExp(`big\\.bin.*${size}`));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rescue never follows a folder link or junction out of the worktree', () => {
  const root = temp();
  try {
    const d = join(root, 'repo'), outside = join(root, 'outside'), g = initRepo(d);
    write(d, 'a.txt', 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
    write(outside, 'out1.txt', 'OUTSIDE FILE\n'); write(outside, 'deep/key.txt', 'deep\n');
    symlinkSync(outside, join(d, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
    write(d, 'mine.txt', 'mine\n');
    const r = rescue({ worktree: d, name: 'rescue/links' });
    const tree = g('ls-tree', '-r', '--name-only', 'rescue/links').split('\n');
    assert.ok(tree.includes('mine.txt'));
    assert.ok(!tree.some(p => p.startsWith('shortcut/')), `nothing from outside is committed: ${tree.join(', ')}`);
    // git for Windows lists the files behind a junction one by one: each is left out and named in the manifest;
    // on POSIX git sees a symlink, and only the link itself is committed
    for (const x of r.left.filter(x => x.path.startsWith('shortcut/'))) assert.match(x.why, /outside the worktree/);
    if (process.platform === 'win32') assert.ok(r.left.some(x => x.path === 'shortcut/out1.txt'));
    assert.equal(readFileSync(join(outside, 'out1.txt'), 'utf8'), 'OUTSIDE FILE\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
