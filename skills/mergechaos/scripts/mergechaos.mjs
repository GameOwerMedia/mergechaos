#!/usr/bin/env node
// mergechaos: untangle many branches, worktrees and half-finished agent sessions, then land them in dependency order.
//
//   inventory  facts from git, no model: branches, worktrees, uncommitted work, stale sessions, premerge reports, overlaps
//   plan       a draft plan with one verdict per branch: TAKE, ASK (purpose not understood) or ARCHIVE
//   integrate  merges the TAKE branches, in order, into merge/<stamp> inside a separate worktree
//   rescue     commits a dead session's uncommitted work to rescue/<name>/<date> through a temporary index
//   land       moves the base branch to the tested integration commit without clobbering anyone's uncommitted edits
//   archive    turns finished rescue branches and ARCHIVE verdicts into archive/* tags and removes the branch refs
//
// Nothing here checks out, stashes, resets or cleans a working tree that someone else may be using.
// No dependencies: Node.js 20+ and git 2.25+ (2.38+ for conflict prediction with git merge-tree --write-tree).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateFile, scanBuffer, utf16Kind } from './safety.mjs';

export const VERSION = '0.1.0';
export const SCHEMA = 1;
export const REPORT_DIR = 'docs/premerge';
const MARKER = 'premerge-json';
const PROD_PATTERN = /^(prod|production|release)([-_/].*)?$|^(main|master)$/;
const BASE_CANDIDATES = ['main', 'master', 'trunk', 'develop'];
const MAX_BRANCHES = 80, MAX_COMMITS = 300, MAX_DIRTY_STAT = 3000;
export { PRIVATE_FILE, isPrivateFile, secretKinds, scanBuffer } from './safety.mjs';

// ---------- git and small helpers ----------

/** Environment for every git call: never take optional locks in other people's worktrees (git status refreshes the index). */
const gitEnv = env => ({ ...(env || process.env), GIT_OPTIONAL_LOCKS: '0' });
/** Runs git with unquoted non-ASCII paths, so file names in every listing are real names. */
export function git(cwd, args, { env, input, allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd, env: gitEnv(env), input, encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.replace(/\s+$/, '');
}
const gitRaw = (cwd, args, { encoding = 'utf8', env } = {}) =>
  spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: gitEnv(env), encoding, maxBuffer: 256 << 20, windowsHide: true });
const lines = s => (s ? s.split('\n').filter(Boolean) : []);
const isAncestor = (cwd, a, b) => gitRaw(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0;
const refExists = (cwd, ref) => git(cwd, ['rev-parse', '--verify', '-q', ref], { allowFail: true }) !== null;
const real = p => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const norm = p => real(p).replace(/\\/g, '/').replace(/\/+$/, '');
export const samePath = (a, b) => (process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));
export const slug = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
export const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
const code = s => `\`${s}\``;
const commonDir = repo => path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']));
/** Top folder of the main worktree, also when `dir` is inside a linked worktree. */
export function mainRoot(dir) {
  const c = commonDir(dir);
  return path.basename(c) === '.git' ? path.dirname(c) : git(dir, ['rev-parse', '--show-toplevel']);
}
/** Commits in `b` that `a` lacks (ahead) and commits in `a` that `b` lacks (behind). */
const position = (cwd, a, b) => { const [behind, ahead] = git(cwd, ['rev-list', '--left-right', '--count', `${a}...${b}`]).split(/\s+/).map(Number); return { ahead, behind }; };

const REPEATABLE = new Set(['repo', 'branch']);
const BOOLEAN = new Set(['allow-collisions', 'json', 'dry-run', 'no-merge-collisions', 'keep-branch', 'help', 'version']);
export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const eq = a.indexOf('='), key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const val = eq > 0 ? a.slice(eq + 1) : BOOLEAN.has(key) ? true : argv[++i];
    if (REPEATABLE.has(key)) (o[key] ||= []).push(...String(val).split(',').map(x => x.trim()).filter(Boolean));
    else o[key] = val;
  }
  return o;
}

export function defaultBase(repo) {
  const origin = git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (origin) { const b = origin.replace(/^origin\//, ''); if (refExists(repo, `refs/heads/${b}`)) return b; }
  for (const b of BASE_CANDIDATES) if (refExists(repo, `refs/heads/${b}`)) return b;
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

// ---------- worktrees and uncommitted work ----------

export function worktrees(repo) {
  const out = []; let cur = null;
  for (const l of (git(repo, ['worktree', 'list', '--porcelain']) || '').split('\n').concat([''])) {
    if (l.startsWith('worktree ')) cur = { path: l.slice(9), branch: null };
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && l === 'detached') cur.detached = true;
    else if (cur && l === 'bare') cur.bare = true;
    else if (cur && l.startsWith('prunable')) cur.prunable = true;
    else if (!l && cur) { out.push(cur); cur = null; }
  }
  return out;
}

/** `git status -z` entries: { xy, path, from }. Renames carry the old path in `from`. */
export function statusEntries(dir) {
  const raw = gitRaw(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (raw.status !== 0) return null;
  const t = raw.stdout.split('\0'), out = [];
  for (let i = 0; i < t.length; i++) {
    if (!t[i]) continue;
    const e = { xy: t[i].slice(0, 2), path: t[i].slice(3) };
    if (/[RC]/.test(e.xy)) e.from = t[++i];
    out.push(e);
  }
  return out;
}

/** Uncommitted changes grouped by top-level folder. */
export function dirtyByFolder(entries) {
  const by = {};
  for (const e of entries) {
    const top = e.path.includes('/') ? e.path.split('/')[0] + '/' : e.path;
    const k = (by[top] ||= { folder: top, modified: 0, untracked: 0 });
    if (e.xy === '??') k.untracked++; else k.modified++;
  }
  return Object.values(by).sort((a, b) => (b.modified + b.untracked) - (a.modified + a.untracked));
}

/**
 * State of a worktree: clean, live (uncommitted edits younger than `staleHours`), stale (older: the session that
 * made them is probably gone) or missing (registered but not on disk). Age = newest mtime among the dirty files.
 */
export function worktreeState(wt, { staleHours = 24, now = Date.now() } = {}) {
  if (!existsSync(wt.path)) return { ...wt, exists: false, state: 'missing', dirty: null, dirtyByFolder: [] };
  const entries = statusEntries(wt.path) || [];
  let newest = 0;
  for (const e of entries.slice(0, MAX_DIRTY_STAT)) { try { newest = Math.max(newest, statSync(path.join(wt.path, e.path)).mtimeMs); } catch { /* deleted */ } }
  const state = !entries.length ? 'clean' : (newest && now - newest > staleHours * 36e5) ? 'stale' : 'live';
  return { ...wt, exists: true, state, dirty: entries.length, lastEdit: newest ? new Date(newest).toISOString() : null, dirtyByFolder: dirtyByFolder(entries).slice(0, 8) };
}

// ---------- premerge reports ----------

export function reportJson(md) {
  const m = String(md || '').match(new RegExp('```' + MARKER + '\\r?\\n([\\s\\S]*?)\\r?\\n```'));
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

/** Registry rows (newest per repo and branch) from `<.git>/premerge/registry.jsonl` and PREMERGE_REGISTRY. */
export function registryRows(repo) {
  const dirs = [path.join(commonDir(repo), 'premerge'), process.env.PREMERGE_REGISTRY].filter(Boolean);
  const m = new Map(), name = path.basename(mainRoot(repo)), cd = commonDir(repo);
  for (const d of dirs) {
    let t = ''; try { t = readFileSync(path.join(d, 'registry.jsonl'), 'utf8'); } catch { continue; }
    for (const l of t.split('\n')) {
      try { const j = JSON.parse(l); if (j.repo === name && (!j.repoPath || samePath(j.repoPath, cd))) m.set(j.branch, j); } catch { /* torn line */ }
    }
  }
  return m;
}

/** Current = every commit after the head the report describes only touches report files. */
export function reportIsCurrent(repo, branch, head) {
  if (!head || !refExists(repo, `${head}^{commit}`) || !isAncestor(repo, head, branch)) return false;
  return lines(git(repo, ['diff', '--name-only', '--no-renames', head, branch])).every(f => f.startsWith(`${REPORT_DIR}/`));
}

function reportFor(repo, branch, registry) {
  const onBranch = reportJson(git(repo, ['show', `refs/heads/${branch}:${REPORT_DIR}/${slug(branch)}.md`], { allowFail: true }));
  const fromRegistry = registry.get(branch);
  const pick = [onBranch && { ...onBranch, source: 'branch' }, fromRegistry && { ...fromRegistry, source: 'registry' }].filter(Boolean)
    .map(r => ({ ...r, current: reportIsCurrent(repo, branch, r.head) }))
    .sort((a, b) => (b.current - a.current) || String(b.at).localeCompare(String(a.at)))[0];
  if (!pick) return null;
  return { why: pick.why || null, author: pick.author || null, status: pick.status || null, dependsOn: pick.dependsOn || [], head: pick.head || null,
    current: pick.current, source: pick.source, partial: pick.partial || [], hotFiles: pick.hotFiles || [], at: pick.at || null };
}

// ---------- inventory ----------

/** Conflict prediction against the base: [] = clean, [files] = conflicts, null = git too old to tell. */
export function predictConflicts(repo, base, branch) {
  const r = gitRaw(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch]);
  if (r.status === 0) return [];
  if (r.status === 1) return lines(r.stdout).slice(1);
  return null;
}

/** Files changed by at least two branches: where the merge conflicts will be. */
export function overlaps(branches) {
  const who = new Map();
  for (const b of branches) for (const f of b.files || []) (who.get(f) || who.set(f, []).get(f)).push(b.name);
  return [...who.entries()].filter(([, bs]) => bs.length > 1).map(([file, bs]) => ({ file, branches: bs })).sort((a, b) => b.branches.length - a.branches.length);
}

export function inventoryRepo(dir, { days = 30, staleHours = 24, base: forcedBase } = {}) {
  const repo = mainRoot(dir), base = forcedBase || defaultBase(repo), since = Date.now() - days * 864e5, registry = registryRows(repo);
  const allHeads = lines(git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  const production = allHeads.filter(b => b !== base && PROD_PATTERN.test(b)).map(b => ({ branch: b, ...position(repo, base, b) }));
  const wts = worktrees(repo).filter(w => !w.bare).map(w => ({ ...worktreeState(w, { staleHours }), main: samePath(w.path, repo) }));
  const branches = [];
  for (const l of lines(git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:iso-strict)', 'refs/heads']))) {
    const [name, last] = l.split('\t');
    if (name === base || production.some(p => p.branch === name) || name.startsWith('merge/')) continue;
    if (Date.parse(last) < since && !name.startsWith('rescue/')) continue;
    if (branches.length >= MAX_BRANCHES) break;
    const pos = position(repo, base, name);
    if (pos.ahead === 0) continue;                                   // fully merged already
    const commits = (git(repo, ['log', '--name-only', '--format=@@%h\t%aI\t%s', `${base}..${name}`, '-n', String(MAX_COMMITS)]) || '').split('@@').filter(Boolean).map(block => {
      const [head, ...rest] = block.split('\n'), [h, at, subject] = head.split('\t');
      return { h, at: new Date(at).toISOString(), subject, files: rest.map(x => x.trim()).filter(Boolean).length };
    });
    const files = lines(git(repo, ['diff', '--name-only', '--no-renames', `${base}...${name}`]));
    const work = files.filter(f => !f.startsWith(`${REPORT_DIR}/`));
    const cherry = lines(git(repo, ['cherry', base, name], { allowFail: true }) || '');
    branches.push({
      name, last: new Date(last).toISOString(), ...pos, head: git(repo, ['rev-parse', name]), commits, files: work,
      reportOnly: files.length > 0 && work.length === 0,
      alreadyInBase: cherry.length > 0 && cherry.every(c => c.startsWith('-')),
      rescue: name.startsWith('rescue/'),
      worktree: wts.find(w => w.branch === name)?.path || null,
      report: reportFor(repo, name, registry),
      conflicts: predictConflicts(repo, base, name),
    });
  }
  const ov = overlaps(branches.filter(b => !b.rescue));
  const entry = { name: path.basename(repo), path: repo.replace(/\\/g, '/'), base, baseTip: git(repo, ['rev-parse', base]), production, worktrees: wts, branches, overlaps: ov.slice(0, 60), pairConflicts: pairConflicts(repo, branches.filter(b => !b.rescue && !b.alreadyInBase), ov) };
  entry.chaos = chaosScore(entry);
  return entry;
}

/** Branch pairs that share files and would conflict with each other (merged in either order). */
export function pairConflicts(repo, branches, ov, { limit = 100 } = {}) {
  const pairs = new Map();
  for (const o of ov) for (let i = 0; i < o.branches.length; i++) for (let j = i + 1; j < o.branches.length; j++) {
    const k = [o.branches[i], o.branches[j]].sort().join('\n');
    if (!pairs.has(k) && pairs.size < limit) pairs.set(k, [o.branches[i], o.branches[j]].sort());
  }
  const known = new Set(branches.map(b => b.name)), out = [];
  for (const [a, b] of pairs.values()) {
    if (!known.has(a) || !known.has(b) || isAncestor(repo, a, b) || isAncestor(repo, b, a)) continue;
    const files = predictConflicts(repo, a, b);
    if (files?.length) out.push({ branches: [a, b], files });
  }
  return out;
}

/** Higher = more urgent: branches, missing reports, overlaps, uncommitted work, stale sessions, production lag. */
export function chaosScore(r) {
  const noReport = r.branches.filter(b => !b.report || !b.report.current).length;
  const dirty = r.worktrees.reduce((a, w) => a + (w.dirty || 0), 0);
  return r.branches.length * 2 + noReport * 3 + r.overlaps.length + (r.pairConflicts?.length || 0) * 2 + Math.min(50, Math.round(dirty / 5)) + r.worktrees.filter(w => w.state === 'stale' || w.state === 'missing').length * 3
    + Math.min(20, r.production.reduce((a, p) => a + (p.behind || 0), 0));
}

export function inventory(dirs, opts = {}) {
  const seen = new Map();
  for (const d of dirs) {
    if (!existsSync(d)) { seen.set(`missing:${d}`, { name: path.basename(d), path: d, error: 'folder not found' }); continue; }
    const top = git(d, ['rev-parse', '--show-toplevel'], { allowFail: true });
    if (!top) { seen.set(`nogit:${d}`, { name: path.basename(d), path: d, error: 'not a git repository' }); continue; }
    const root = mainRoot(top), key = norm(root).toLowerCase();
    if (!seen.has(key)) seen.set(key, inventoryRepo(root, opts));          // linked worktrees count once, with their main repo
  }
  const repos = [...seen.values()].sort((a, b) => (b.chaos || 0) - (a.chaos || 0));
  return { schema: SCHEMA, tool: `mergechaos ${VERSION}`, at: new Date().toISOString(), days: opts.days || 30, staleHours: opts.staleHours || 24, repos };
}

export function renderMap(map) {
  const ok = map.repos.filter(r => !r.error);
  const s = [`# Merge chaos map`, '', `Generated ${map.at} by ${map.tool}. Facts from git only. Window: branches with commits in the last ${map.days} days; a worktree is stale after ${map.staleHours} h without edits.`, '',
    `Repositories: ${map.repos.length}. Unmerged branches: ${ok.reduce((a, r) => a + r.branches.length, 0)}. Without a current premerge report: ${ok.reduce((a, r) => a + r.branches.filter(b => !b.report?.current).length, 0)}.`, '',
    '| Chaos | Repository | Base | Branches (no current report) | Overlapping files | Uncommitted | Worktrees (stale) |', '|---:|---|---|---|---:|---:|---|'];
  for (const r of map.repos) {
    if (r.error) { s.push(`| - | ${code(r.name)} | | ${r.error} | | | |`); continue; }
    s.push(`| ${r.chaos} | ${code(r.name)} | ${code(r.base)} | ${r.branches.length} (${r.branches.filter(b => !b.report?.current).length}) | ${r.overlaps.length} | ${r.worktrees.reduce((a, w) => a + (w.dirty || 0), 0)} | ${r.worktrees.length} (${r.worktrees.filter(w => w.state === 'stale' || w.state === 'missing').length}) |`);
  }
  s.push('');
  for (const r of ok) {
    s.push(`## ${r.name}`, '', `- Path: ${code(r.path)}`, `- Base ${code(r.base)} at ${code(r.baseTip.slice(0, 10))}${r.production.length ? `; production: ${r.production.map(p => `${code(p.branch)} ${p.behind} behind / ${p.ahead} ahead of base`).join('; ')}` : '; no production branch'}`);
    s.push('', '| Worktree | Branch | State | Uncommitted | Last edit | By folder |', '|---|---|---|---:|---|---|');
    for (const w of r.worktrees) s.push(`| ${code(w.path.replace(/\\/g, '/'))}${w.main ? ' (main)' : ''} | ${w.branch ? code(w.branch) : w.detached ? '(detached)' : ''} | ${w.state} | ${w.dirty ?? ''} | ${w.lastEdit ? w.lastEdit.slice(0, 16).replace('T', ' ') : ''} | ${w.dirtyByFolder.map(d => `${code(d.folder)} ${d.modified}M/${d.untracked}?`).join(', ')} |`);
    if (r.branches.length) {
      s.push('', '| Branch | Last commit | Ahead/behind | Predicted conflicts | Premerge report (why) |', '|---|---|---|---|---|');
      for (const b of r.branches) {
        const rep = !b.report ? '**missing**' : `${b.report.current ? '' : '**(stale)** '}${b.report.status && b.report.status !== 'ready' ? `[${b.report.status}] ` : ''}${b.report.why || '(no why)'}`;
        const notes = [b.rescue && 'rescue', b.reportOnly && 'report only', b.alreadyInBase && 'already in base'].filter(Boolean).join(', ');
        s.push(`| ${code(b.name)}${notes ? ` (${notes})` : ''} | ${b.last.slice(0, 16).replace('T', ' ')} | ${b.ahead}/${b.behind} | ${b.conflicts === null ? '?' : b.conflicts.length ? b.conflicts.map(code).join(', ') : 'none'} | ${rep} |`);
      }
    }
    if (r.overlaps.length) s.push('', '**Files changed by several branches:**', ...r.overlaps.slice(0, 20).map(x => `- ${code(x.file)}: ${x.branches.map(code).join(', ')}`));
    if (r.pairConflicts?.length) s.push('', '**Predicted conflicts between branches** (git merge-tree):', ...r.pairConflicts.map(x => `- ${x.branches.map(code).join(' and ')}: ${x.files.map(code).join(', ')}`));
    s.push('');
    for (const b of r.branches) s.push(`<details><summary><code>${b.name}</code>: ${b.commits.length} commit(s)</summary>`, '', ...b.commits.slice(0, 40).map(c => `- ${code(c.h)} ${c.at.slice(0, 16).replace('T', ' ')} ${c.subject} (${c.files} files)`), '', '</details>', '');
  }
  return s.join('\n');
}

// ---------- plan ----------

/** One verdict per branch. Never TAKE without a current report that says why; the script cannot understand purpose. */
export function verdict(b, { taken = new Set() } = {}) {
  if (b.rescue) return { verdict: 'ARCHIVE', reason: 'Rescue branch: keep as an archive tag; cherry-pick from it only what a person approves.' };
  if (b.alreadyInBase) return { verdict: 'ARCHIVE', reason: 'Every commit is already in the base under another hash (git cherry); nothing left to merge.' };
  const r = b.report;
  if (!r) return { verdict: 'ASK', reason: 'No premerge report: the purpose of this branch is unknown. Ask its author to write one.' };
  if (!r.why) return { verdict: 'ASK', reason: 'The report does not say why the change exists.' };
  if (!r.current) return { verdict: 'ASK', reason: 'The branch moved after its report was written; the report no longer describes it.' };
  if (/^reconstructed$/i.test(r.author || '')) return { verdict: 'ASK', reason: 'The report was reconstructed from commits, not written by the author.' };
  if (r.status && r.status !== 'ready') return { verdict: 'ASK', reason: `The author marked it ${r.status}.` };
  const missing = (r.dependsOn || []).filter(d => !taken.has(d));
  if (missing.length) return { verdict: 'ASK', reason: `Depends on ${missing.join(', ')}, which is not taken in this run.` };
  const notes = [b.reportOnly && 'report only, the work is already in the base', b.conflicts?.length && `resolve ${b.conflicts.length} conflict(s) keeping both sides`, r.partial?.length && `partial files: take only the branch version of ${r.partial.join(', ')}`].filter(Boolean);
  return { verdict: 'TAKE', reason: `${r.why}${notes.length ? ` (${notes.join('; ')})` : ''}` };
}

/** Dependencies first (premerge `dependsOn`), then clean merges before conflicting ones, then oldest first. */
export function order(branches) {
  const by = new Map(branches.map(b => [b.name, b])), done = new Set(), out = [], visiting = new Set();
  const rank = [...branches].sort((a, b) => ((a.conflicts?.length || 0) - (b.conflicts?.length || 0)) || a.last.localeCompare(b.last));
  const visit = b => {
    if (done.has(b.name) || visiting.has(b.name)) return;
    visiting.add(b.name);
    for (const d of b.report?.dependsOn || []) if (by.has(d)) visit(by.get(d));
    visiting.delete(b.name); done.add(b.name); out.push(b);
  };
  rank.forEach(visit);
  return out;
}

export function makePlan(map, { at = new Date() } = {}) {
  const st = stamp(at);
  const repos = map.repos.filter(r => !r.error).map(r => {
    const ordered = order(r.branches.filter(b => !b.rescue)), taken = new Set(), steps = [];
    for (const b of ordered) {
      const v = verdict(b, { taken });
      if (v.verdict === 'TAKE') taken.add(b.name);
      const withOthers = (r.pairConflicts || []).filter(p => p.branches.includes(b.name)).map(p => ({ branch: p.branches.find(x => x !== b.name), files: p.files }));
      steps.push({ branch: b.name, head: b.head, verdict: v.verdict, reason: v.reason, conflicts: b.conflicts, conflictsWith: withOthers, author: b.report?.author || null, worktree: b.worktree });
    }
    for (const b of r.branches.filter(x => x.rescue)) steps.push({ branch: b.name, head: b.head, verdict: 'ARCHIVE', reason: verdict(b).reason, conflicts: null, conflictsWith: [], author: null, worktree: b.worktree });
    const rescue = r.worktrees.filter(w => w.state === 'stale').map(w => ({ worktree: w.path, branch: w.branch, dirty: w.dirty, lastEdit: w.lastEdit }));
    const live = r.worktrees.filter(w => w.state === 'live').map(w => ({ worktree: w.path, branch: w.branch, dirty: w.dirty }));
    const prune = r.worktrees.filter(w => w.state === 'missing').map(w => w.path);
    return { name: r.name, path: r.path, base: r.base, baseTip: r.baseTip, integration: `merge/${st}`, steps, rescue, live, prune };
  });
  return { schema: SCHEMA, tool: `mergechaos ${VERSION}`, at: at.toISOString(), stamp: st, mapAt: map.at, repos };
}

const conflictCell = x => {
  const parts = [];
  if (x.conflicts === null) parts.push('with base: ?'); else if (x.conflicts.length) parts.push(`with base: ${x.conflicts.map(code).join(', ')}`);
  for (const w of x.conflictsWith || []) parts.push(`with ${code(w.branch)}: ${w.files.map(code).join(', ')}`);
  return parts.join('; ') || 'none';
};

export function renderPlan(plan, { runDir = '<run>' } = {}) {
  const all = plan.repos.flatMap(r => r.steps);
  const count = v => all.filter(s => s.verdict === v).length;
  const s = [`# Merge plan ${plan.stamp}`, '', `Draft by ${plan.tool} from the map of ${plan.mapAt}. Verdicts: TAKE ${count('TAKE')}, ASK ${count('ASK')}, ARCHIVE ${count('ARCHIVE')}.`, '',
    'This is a draft. Read every premerge report, then edit `plan.json` (verdict and reason) before `integrate`. Change ASK to TAKE only when you can say, in one sentence, why the branch exists. Nothing in this plan touches a base branch until `land` runs with the owner\'s go-ahead.', ''];
  for (const r of plan.repos) {
    s.push(`## ${r.name}`, '', `Base ${code(r.base)} at ${code(r.baseTip.slice(0, 10))}; integration branch ${code(r.integration)} in a separate worktree.`, '');
    if (r.steps.length) {
      s.push('| Order | Branch | Verdict | Reason | Conflicts |', '|---:|---|---|---|---|');
      r.steps.forEach((x, i) => s.push(`| ${i + 1} | ${code(x.branch)} | **${x.verdict}** | ${x.reason.replace(/\|/g, '\\|')} | ${conflictCell(x)} |`));
      s.push('');
    } else s.push('No unmerged branches.', '');
    if (r.rescue.length) s.push('**Stale sessions with uncommitted work (rescue before landing):**', ...r.rescue.map(w => `- ${code(w.worktree)} on ${code(w.branch || 'detached')}: ${w.dirty} change(s), last edit ${w.lastEdit?.slice(0, 16).replace('T', ' ') || '?'}. \`mergechaos rescue --repo "${r.path}" --worktree "${w.worktree}"\``), '');
    if (r.live.length) s.push('**Live sessions (report only, do not touch; the owner commits and writes a premerge report):**', ...r.live.map(w => `- ${code(w.worktree)} on ${code(w.branch || 'detached')}: ${w.dirty} change(s)`), '');
    if (r.prune.length) s.push('**Worktrees registered but missing on disk** (ask, then `git worktree prune`):', ...r.prune.map(p => `- ${code(p)}`), '');
    const asks = r.steps.filter(x => x.verdict === 'ASK');
    if (asks.length) {
      s.push('**Questions (blocking only for their own branch):**', '');
      asks.forEach((x, i) => s.push(`${i + 1}. ${code(x.branch)}${x.author ? ` (author: ${x.author})` : ''}: ${x.reason}`,
        '   - A (recommended): ask the author for a premerge report (`premerge report --why "..." --commit`), then re-run `inventory` and `plan`.',
        '   - B: take it as it is. Only if you can state its purpose yourself; write that purpose into plan.json.',
        '   - C: archive it (tag `archive/<branch>`, nothing is lost).'));
      s.push('');
    }
  }
  s.push('## Next commands', '', '```', `mergechaos integrate --run "${runDir}"`,
    '# run the tests every report lists inside the integration worktree, review the result, then, with the owner\'s go-ahead:',
    ...plan.repos.map(r => `mergechaos land --repo "${r.path}" --base ${r.base} --old ${r.baseTip} --new ${r.integration}`),
    ...plan.repos.map(r => { const arch = r.steps.filter(x => x.verdict === 'ARCHIVE').map(x => x.branch); return `mergechaos archive --repo "${r.path}" --branch ${[...arch, ...(r.rescue.length ? ['<rescue branches created above>'] : [])].join(',') || '<branches>'}`; }),
    '```', '');
  return s.join('\n');
}

// ---------- integrate ----------

/** Merges the TAKE steps in order into the integration branch, in its own worktree. Idempotent: re-run after resolving a conflict. */
export function integrate(plan, { runDir, only = null, log = () => {} } = {}) {
  const results = [];
  for (const r of plan.repos.filter(x => !only || only.includes(x.name))) {
    const res = { repo: r.name, worktree: path.join(runDir, 'wt', slug(r.name)).replace(/\\/g, '/'), branch: r.integration, merged: [], skipped: [], stopped: null };
    results.push(res);
    const take = r.steps.filter(x => x.verdict === 'TAKE');
    if (!take.length) { res.stopped = 'nothing to take'; continue; }
    if (!existsSync(res.worktree)) {
      mkdirSync(path.dirname(res.worktree), { recursive: true });
      if (refExists(r.path, `refs/heads/${r.integration}`)) git(r.path, ['worktree', 'add', res.worktree, r.integration]);
      else git(r.path, ['worktree', 'add', '-b', r.integration, res.worktree, r.baseTip]);
    }
    const wt = res.worktree;
    if (refExists(wt, 'MERGE_HEAD')) { res.stopped = 'a merge is in progress: resolve it, `git commit --no-edit`, then run integrate again'; break; }
    if ((statusEntries(wt) || []).length) { res.stopped = 'the integration worktree has uncommitted changes: commit or discard them first'; break; }
    for (const x of take) {
      const now = git(r.path, ['rev-parse', '--verify', '-q', `refs/heads/${x.branch}`], { allowFail: true });
      if (now !== x.head) { res.stopped = `${x.branch} moved since the plan (or was deleted): re-run inventory and plan`; break; }
      if (isAncestor(wt, x.head, 'HEAD')) { res.skipped.push(x.branch); continue; }
      log(`${r.name}: merging ${x.branch}`);
      const m = gitRaw(wt, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${x.branch} (mergechaos ${plan.stamp})\n\n${x.reason}`, x.head]);
      if (m.status !== 0) {
        const conflicted = lines(git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '');
        res.stopped = conflicted.length ? `conflict merging ${x.branch}` : `git merge failed on ${x.branch}: ${(m.stderr || m.stdout).trim().split('\n')[0]}`;
        res.conflicts = conflicted;
        break;
      }
      res.merged.push(x.branch);
    }
    res.tip = git(wt, ['rev-parse', 'HEAD']);
    if (res.stopped) break;          // later repos wait: the plan is executed in order
  }
  return results;
}

// ---------- rescue ----------

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/**
 * Commits every uncommitted change of a worktree (tracked edits, deletions, untracked files) onto a new branch,
 * through a temporary index. The worktree, its index and its HEAD are not touched. Private file names, contents that
 * look like secrets (UTF-16 decoded, binary scanned as bytes) and files above `maxMb` stay out of the commit; a manifest
 * inside the commit lists them by path, size and SHA-256, never by content. Best effort: see safety.mjs.
 */
export function rescue({ worktree, name, onto = 'HEAD', maxMb = 1, now = new Date() }) {
  const wt = git(worktree, ['rev-parse', '--show-toplevel']);
  const entries = statusEntries(wt) || [];
  if (!entries.length) return { nothing: true };
  const parent = git(wt, ['rev-parse', `${onto}^{commit}`]);
  const branch = name || uniqueBranch(wt, `rescue/${slug(path.basename(wt))}/${now.toISOString().slice(0, 10)}`);
  if (refExists(wt, `refs/heads/${branch}`)) throw new Error(`branch ${branch} already exists; pass --name`);
  const take = new Set(), left = [];
  for (const e of entries) {
    for (const p of [e.path, e.from].filter(Boolean)) {
      const abs = path.join(wt, p);
      if (isPrivateFile(p)) { left.push({ path: p, why: 'private file' }); continue; }
      if (!existsSync(abs)) { take.add(p); continue; }                 // a deletion
      const st = lstatSync(abs);
      if (st.isDirectory()) { left.push({ path: p, why: 'nested repository or submodule' }); continue; }
      if (st.isSymbolicLink()) { take.add(p); continue; }                // the link itself, not its target
      const buf = readFileSync(abs);
      if (st.size > maxMb * 1e6) { left.push({ path: p, why: `larger than ${maxMb} MB`, size: st.size, sha256: sha256(buf) }); continue; }
      const kinds = scanBuffer(buf);
      if (kinds.length) { left.push({ path: p, why: `possible secret (${kinds.join(', ')})` }); continue; }
      take.add(p);
    }
  }
  const idx = path.join(path.resolve(wt, git(wt, ['rev-parse', '--git-dir'])), `mergechaos-rescue-${process.pid}.idx`);
  // literal pathspecs: a file named ".e[n]v" must not pull ".env" in as a glob match
  const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_LITERAL_PATHSPECS: '1' };
  try {
    git(wt, ['read-tree', parent], { env });
    if (take.size) git(wt, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: [...take].join('\0') + '\0' });
    const head = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const table = left.map(x => `| ${code(x.path)} | ${x.why} | ${x.size ?? ''} | ${x.sha256 ? code(x.sha256) : ''} |`);
    const manifest = ['# Rescued uncommitted work', '', `Worktree: ${path.basename(wt)} on ${head} at ${parent.slice(0, 10)}`,
      `Rescued: ${now.toISOString()} by mergechaos ${VERSION}`, '',
      'Not for a direct merge: cherry-pick only what the owner approves. The working tree was not changed; every file below is still on disk.', '',
      `Committed: ${take.size} path(s).`, '',
      ...(left.length ? ['Left out (still on disk, not in this commit):', '', '| Path | Why | Size | sha256 |', '|---|---|---:|---|', ...table]
        : ['Nothing was left out.']), ''].join('\n');
    const blob = git(wt, ['hash-object', '-w', '--stdin'], { input: manifest });
    git(wt, ['update-index', '--add', '--cacheinfo', `100644,${blob},.mergechaos/RESCUE.md`], { env });
    const tree = git(wt, ['write-tree'], { env });
    const c = git(wt, ['commit-tree', tree, '-p', parent], { input: `Rescue of uncommitted work in ${path.basename(wt)} (mergechaos), not for direct merge\n` });
    git(wt, ['update-ref', '-m', 'mergechaos rescue', `refs/heads/${branch}`, c, '']);
    return { branch, commit: c, parent, committed: [...take], left };
  } finally { rmSync(idx, { force: true }); }
}
function uniqueBranch(repo, name) {
  let n = name, i = 2;
  while (refExists(repo, `refs/heads/${n}`)) n = `${name}-${i++}`;
  return n;
}

// ---------- land ----------

const toBuf = x => (Buffer.isBuffer(x) ? x : Buffer.from(String(x)));
/** CRLF and LF conversions on bytes (latin1 round-trips every byte exactly). */
const bytesLF = b => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
const bytesCRLF = b => Buffer.from(b.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');

/**
 * Three-way merge of the base change (old -> new) into a file that holds someone's uncommitted edit.
 * Works on bytes, so any ASCII-compatible encoding (UTF-8, Latin-1, ...) is kept exactly; UTF-16 and binary files
 * are refused and left untouched. Writes only when the merge is clean and the file did not change meanwhile.
 */
export function mergeIntoDisk(file, oldContent, newContent) {
  const snap = readFileSync(file), oldBuf = toBuf(oldContent), newBuf = toBuf(newContent);
  if ([snap, oldBuf, newBuf].some(b => utf16Kind(b))) return { ok: false, why: 'UTF-16 text, merge it by hand' };
  if ([snap, oldBuf, newBuf].some(b => b.includes(0))) return { ok: false, why: 'binary file' };
  const text = snap.toString('latin1');
  const nl = text.split('\n').length - 1, crlf = text.split('\r\n').length - 1, useCrlf = nl > 0 && crlf * 2 > nl;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mergechaos-'));
  try {
    const [d, o, n] = ['disk', 'old', 'new'].map(k => path.join(tmp, k));
    writeFileSync(d, bytesLF(snap)); writeFileSync(o, bytesLF(oldBuf)); writeFileSync(n, bytesLF(newBuf));
    const m = spawnSync('git', ['merge-file', '-p', d, o, n], { encoding: 'buffer', maxBuffer: 256 << 20, windowsHide: true });
    if (m.status !== 0) return { ok: false, why: m.status > 0 && m.status < 128 ? `${m.status} conflict(s)` : 'merge-file failed' };
    if (!readFileSync(file).equals(snap)) return { ok: false, why: 'changed on disk while merging' };
    writeFileSync(file, useCrlf ? bytesCRLF(m.stdout) : m.stdout);
    return { ok: true, eol: useCrlf ? 'CRLF' : 'LF' };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const lstatOrNull = p => { try { return lstatSync(p); } catch { return null; } };
/** A file or symlink sitting where a parent folder of `rel` should be. */
function blockedParent(W, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const st = lstatOrNull(path.join(W, ...parts.slice(0, i)));
    if (st && !st.isDirectory()) return parts.slice(0, i).join('/');
  }
  return null;
}
const isRegular = mode => mode === '100644' || mode === '100755';

/** Classifies one changed path against the disk of the worktree `W`. */
function classify(root, W, { st, p, oldMode, newMode }, { OLD, NEW, fileMode }) {
  const n = git(root, ['rev-parse', '-q', '--verify', `${NEW}:${p}`], { allowFail: true });
  const o = git(root, ['rev-parse', '-q', '--verify', `${OLD}:${p}`], { allowFail: true });
  const abs = path.join(W, p), row = { status: st, path: p };
  const blocked = blockedParent(W, p);
  if (blocked) return { ...row, kind: 'COLLIDE', reason: `a file or link is in the way: ${blocked}` };
  if ([oldMode, newMode].some(m => m !== '000000' && !isRegular(m))) return { ...row, kind: 'COLLIDE', reason: 'symlink or submodule' };
  const ls = lstatOrNull(abs);
  if (ls && ls.isSymbolicLink()) return { ...row, kind: 'COLLIDE', reason: 'a symlink is on disk' };
  if (ls && ls.isDirectory()) return { ...row, kind: 'COLLIDE', reason: 'a folder is on disk' };
  const d = ls ? git(W, ['hash-object', '--', p], { allowFail: true }) : null;
  if (d === n) {
    // same content; a pure mode change (exec bit) is applied only where the filesystem tracks it
    if (ls && n && oldMode !== newMode && fileMode) {
      const exec = (ls.mode & 0o111) !== 0, wantExec = newMode === '100755';
      if (exec !== wantExec) return { ...row, kind: 'SAFE', mode: newMode, reason: 'mode change' };
    }
    return { ...row, kind: 'EQUAL', ...(oldMode !== newMode && !fileMode ? { reason: 'mode change not applied (filesystem without exec bit)' } : {}) };
  }
  if (d === o) return { ...row, kind: 'SAFE' };
  return { ...row, kind: 'COLLIDE' };
}

/** `git diff --raw -z` between two commits: status, path and both modes for every changed path. */
function rawChanges(root, OLD, NEW) {
  const z = git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', OLD, NEW]).split('\0').filter(Boolean), out = [];
  for (let i = 0; i + 1 < z.length; i += 2) {
    const [oldMode, newMode, , , st] = z[i].replace(/^:/, '').split(' ');
    out.push({ st: st[0], p: z[i + 1], oldMode, newMode });
  }
  return out;
}

/** Puts the index entries of collisions left on disk back to the old base, so `git diff` shows exactly the owner's edit. */
function restoreIndexEntries(W, root, OLD, paths) {
  const removals = [], adds = [];
  for (const p of paths) {
    const ls = git(root, ['ls-tree', '-z', OLD, '--', p]).replace(/\0$/, '');
    if (ls) { const [meta] = ls.split('\t'); const [mode, , sha] = meta.split(' '); adds.push(`${mode},${sha},${p}`); } else removals.push(p);
  }
  for (const p of removals) gitRaw(W, ['update-index', '--force-remove', '--', p]);
  for (const a of adds) {
    const p = a.slice(a.indexOf(',', a.indexOf(',') + 1) + 1);
    // a NEW entry under p/ would block the old file entry: drop those first
    for (const under of lines(git(W, ['ls-files', '--', `${p}/`], { allowFail: true }) || '')) gitRaw(W, ['update-index', '--force-remove', '--', under]);
    gitRaw(W, ['update-index', '--add', '--cacheinfo', a]);
  }
}

/**
 * Moves `base` from `old` to `new` (a fast-forward to the tested integration commit) and brings the working tree that
 * has `base` checked out in line, path by path:
 *   EQUAL    the disk already holds the new content: nothing to write
 *   SAFE     the disk still holds the old base content (and no file blocks its folder): written from the new commit
 *   COLLIDE  anything else (someone's uncommitted edit, a file in the way, a symlink, a submodule)
 * By default any COLLIDE path refuses the landing: nothing is written and the ref does not move (`refused`).
 * With allowCollisions the SAFE paths land anyway; the base change is merged three-way into an edited text file when
 * that merges cleanly, otherwise the path is left exactly as it is on disk, its index entry goes back to the old base,
 * and it is listed as unresolved.
 * Classification is repeated right before writing; a concurrent editor can still race the final write.
 */
export function land({ repo, base, oldRef, newRef, dryRun = false, allowCollisions = false, mergeCollisions = true }) {
  const root = mainRoot(repo);
  const OLD = git(root, ['rev-parse', `${oldRef}^{commit}`]), NEW = git(root, ['rev-parse', `${newRef}^{commit}`]);
  const tip = git(root, ['rev-parse', `refs/heads/${base}`]);
  if (tip !== OLD) return { stopped: `${base} moved since the plan (${tip.slice(0, 10)} is not ${OLD.slice(0, 10)}): merge it into the integration branch again and retest` };
  if (!isAncestor(root, OLD, NEW)) return { stopped: `${newRef} does not contain ${base}: not a fast-forward` };
  const wt = worktrees(root).find(w => w.branch === base && existsSync(w.path));
  if (!wt) {
    if (!dryRun) git(root, ['update-ref', '-m', `mergechaos land: ${base} -> ${newRef}`, `refs/heads/${base}`, NEW, OLD]);
    return { base, old: OLD, new: NEW, worktree: null, table: [], moved: !dryRun, collisions: [], unresolved: [] };
  }
  const W = wt.path;
  if (gitRaw(W, ['diff', '--cached', '--quiet']).status !== 0) return { stopped: `something is staged in ${W}: the owner commits or unstages it first` };
  if (refExists(W, 'MERGE_HEAD') || refExists(W, 'REBASE_HEAD') || refExists(W, 'CHERRY_PICK_HEAD')) return { stopped: `a merge, rebase or cherry-pick is in progress in ${W}` };
  const ctx = { OLD, NEW, fileMode: git(W, ['config', '--bool', 'core.filemode'], { allowFail: true }) !== 'false' && process.platform !== 'win32' };
  const changes = rawChanges(root, OLD, NEW);
  const table = changes.map(c => classify(root, W, c, ctx));
  const refuse = () => ({ refused: true, base, old: OLD, new: NEW, worktree: W, table, collisions: table.filter(t => t.kind === 'COLLIDE') });
  const colliding = table.some(t => t.kind === 'COLLIDE');
  if (dryRun) return { base, old: OLD, new: NEW, worktree: W, table, dryRun: true, wouldRefuse: colliding && !allowCollisions };
  if (colliding && !allowCollisions) return refuse();
  // second look right before writing: anything that changed since the first pass becomes COLLIDE
  changes.forEach((c, i) => {
    if (table[i].kind !== 'SAFE') return;
    const again = classify(root, W, c, ctx);
    if (again.kind !== 'SAFE') table[i] = { ...again, kind: 'COLLIDE', reason: again.reason || 'changed on disk during landing' };
  });
  if (!allowCollisions && table.some(t => t.kind === 'COLLIDE')) return refuse();
  const safe = table.filter(t => t.kind === 'SAFE');
  const write = safe.filter(t => t.status !== 'D' && !t.mode).map(t => t.path);
  if (write.length) {
    const idx = path.join(path.resolve(W, git(W, ['rev-parse', '--git-dir'])), `mergechaos-land-${process.pid}.idx`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    try {
      // every path here was verified twice: the disk holds the old blob (or nothing) and no file blocks its folders
      git(W, ['read-tree', NEW], { env });
      git(W, ['checkout-index', '-f', '-z', '--stdin'], { env, input: write.join('\0') + '\0' });
    } finally { rmSync(idx, { force: true }); }
  }
  for (const t of safe.filter(x => x.mode)) chmodSync(path.join(W, t.path), t.mode === '100755' ? 0o755 : 0o644);
  for (const t of safe.filter(x => x.status === 'D')) { try { unlinkSync(path.join(W, t.path)); } catch { /* already gone */ } }
  git(root, ['update-ref', '-m', `mergechaos land: ${base} -> ${newRef}`, `refs/heads/${base}`, NEW, OLD]);
  // the shared index follows the ref (two-tree read-tree: no -u, the working tree stays as it is)
  if (gitRaw(W, ['read-tree', '-m', '-i', OLD, NEW]).status !== 0) git(W, ['read-tree', NEW]);
  gitRaw(W, ['update-index', '-q', '--refresh']);
  const collisions = [];
  for (const t of table.filter(x => x.kind === 'COLLIDE')) {
    if (t.reason) { collisions.push({ ...t, result: `left as is: ${t.reason}` }); continue; }
    if (!mergeCollisions) { collisions.push({ ...t, result: 'left as is' }); continue; }
    if (t.status !== 'M' || !existsSync(path.join(W, t.path))) { collisions.push({ ...t, result: 'left as is: added or deleted on one side' }); continue; }
    const show = c => gitRaw(root, ['show', `${c}:${t.path}`], { encoding: 'buffer' }).stdout;
    const r = mergeIntoDisk(path.join(W, t.path), show(OLD), show(NEW));
    collisions.push({ ...t, result: r.ok ? `merged into the uncommitted edit (${r.eol})` : `left as is: ${r.why}` });
  }
  const unresolved = collisions.filter(c => c.result.startsWith('left')).map(c => c.path);
  if (unresolved.length) restoreIndexEntries(W, root, OLD, unresolved);
  gitRaw(W, ['update-index', '-q', '--refresh']);
  return {
    base, old: OLD, new: NEW, worktree: W, table, wrote: write.length, deleted: safe.filter(t => t.status === 'D').length, collisions, moved: true,
    unresolved, statusAfter: (statusEntries(W) || []).length,
  };
}

// ---------- archive ----------

/** Tags each branch as archive/<branch> and removes the branch ref. Commits stay reachable; nothing is deleted from history. */
export function archive(repo, branches, { prefix = 'archive/', keepBranch = false } = {}) {
  const root = mainRoot(repo), out = [];
  for (const b of branches) {
    try {
      const sha = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${b}`], { allowFail: true });
      if (!sha) { out.push({ branch: b, skipped: 'no such branch' }); continue; }
      const wt = worktrees(root).find(w => w.branch === b);
      if (wt && !keepBranch) { out.push({ branch: b, skipped: `checked out in ${wt.path}` }); continue; }
      let tag = `${prefix}${b}`, i = 2;
      while (refExists(root, `refs/tags/${tag}`) && git(root, ['rev-parse', `refs/tags/${tag}^{commit}`]) !== sha) tag = `${prefix}${b}-${i++}`;
      if (!refExists(root, `refs/tags/${tag}`)) git(root, ['tag', '-a', '-m', `Archived by mergechaos: ${b}`, tag, sha]);
      if (!keepBranch) git(root, ['update-ref', '-d', `refs/heads/${b}`, sha]);
      out.push({ branch: b, tag, commit: sha.slice(0, 10), removed: !keepBranch });
    } catch (e) {
      out.push({ branch: b, skipped: `error, branch kept: ${String(e.message).split('\n')[0]}` });
    }
  }
  return out;
}

// ---------- CLI ----------

const HELP = `mergechaos ${VERSION}: untangle many branches, worktrees and agent sessions, then land them in order.

  mergechaos.mjs inventory --repo <dir> [--repo <dir>...] [--repos-file <list.txt>] [--days 30] [--stale-hours 24] [--base <b>] [--out <run dir>] [--json]
  mergechaos.mjs plan      --run <run dir> [--json]
  mergechaos.mjs integrate --run <run dir> [--repo <name>]
  mergechaos.mjs rescue    --worktree <dir> [--name rescue/<x>] [--onto <ref>] [--max-mb 1] [--json]
  mergechaos.mjs land      --repo <dir> --base <branch> --old <sha> --new <ref> [--dry-run] [--allow-collisions [--no-merge-collisions]] [--json]
  mergechaos.mjs archive   --repo <dir> --branch <b>[,<b>...] [--prefix archive/] [--keep-branch]

Run folder default: $MERGECHAOS_DIR/<stamp> or ~/.mergechaos/runs/<stamp>.`;
const runsRoot = () => process.env.MERGECHAOS_DIR || path.join(os.homedir(), '.mergechaos', 'runs');
const out = (o, json, text) => console.log(o.json ? JSON.stringify(json, null, 1) : text);

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv), cmd = o._[0];
  if (o.version) { console.log(VERSION); return 0; }
  if (o.help || !cmd) { console.log(HELP); return cmd || o.help ? 0 : 2; }

  if (cmd === 'inventory') {
    const dirs = [...(o.repo || []), ...(o['repos-file'] ? readFileSync(o['repos-file'], 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')) : [])];
    if (!dirs.length) dirs.push(process.cwd());
    const map = inventory(dirs.map(d => path.resolve(d)), { days: Number(o.days) || 30, staleHours: Number(o['stale-hours']) || 24, base: o.base });
    const run = path.resolve(o.out || path.join(runsRoot(), stamp(new Date(map.at))));
    mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, 'map.json'), JSON.stringify(map, null, 1));
    writeFileSync(path.join(run, 'MAP.md'), renderMap(map));
    const ok = map.repos.filter(r => !r.error);
    out(o, { run, repos: map.repos.length, branches: ok.reduce((a, r) => a + r.branches.length, 0) },
      `Map: ${path.join(run, 'MAP.md')}\nRepositories: ${map.repos.length}, unmerged branches: ${ok.reduce((a, r) => a + r.branches.length, 0)}, without a current report: ${ok.reduce((a, r) => a + r.branches.filter(b => !b.report?.current).length, 0)}, stale worktrees: ${ok.reduce((a, r) => a + r.worktrees.filter(w => w.state === 'stale').length, 0)}\nNext: mergechaos plan --run "${run}"`);
    return 0;
  }
  if (cmd === 'plan') {
    if (!o.run) throw usage('plan needs --run <run dir>');
    const run = path.resolve(o.run), map = JSON.parse(readFileSync(path.join(run, 'map.json'), 'utf8'));
    const plan = makePlan(map);
    writeFileSync(path.join(run, 'plan.json'), JSON.stringify(plan, null, 1));
    writeFileSync(path.join(run, 'PLAN.md'), renderPlan(plan, { runDir: run.replace(/\\/g, '/') }));
    const all = plan.repos.flatMap(r => r.steps);
    out(o, plan, `Plan: ${path.join(run, 'PLAN.md')}\nTAKE ${all.filter(s => s.verdict === 'TAKE').length}, ASK ${all.filter(s => s.verdict === 'ASK').length}, ARCHIVE ${all.filter(s => s.verdict === 'ARCHIVE').length}. Review plan.json before integrate.`);
    return 0;
  }
  if (cmd === 'integrate') {
    if (!o.run) throw usage('integrate needs --run <run dir>');
    const run = path.resolve(o.run), plan = JSON.parse(readFileSync(path.join(run, 'plan.json'), 'utf8'));
    const res = integrate(plan, { runDir: run, only: o.repo || null, log: m => !o.json && console.log(m) });
    writeFileSync(path.join(run, 'integrate.json'), JSON.stringify(res, null, 1));
    out(o, res, res.map(r => `${r.repo}: ${r.merged.length} merged${r.skipped.length ? `, ${r.skipped.length} already in` : ''} on ${r.branch} at ${r.tip?.slice(0, 10) || '-'} (${r.worktree})${r.stopped ? `\n  STOPPED: ${r.stopped}${r.conflicts?.length ? `\n  conflicted: ${r.conflicts.join(', ')}\n  resolve in the worktree keeping both sides, git commit --no-edit, then run integrate again` : ''}` : ''}`).join('\n'));
    return res.some(r => r.conflicts?.length) ? 6 : res.some(r => r.stopped && r.stopped !== 'nothing to take') ? 1 : 0;
  }
  if (cmd === 'rescue') {
    const r = rescue({ worktree: path.resolve(o.worktree || (o.repo || [])[0] || process.cwd()), name: o.name, onto: o.onto || 'HEAD', maxMb: Number(o['max-mb']) || 1 });
    if (r.nothing) { out(o, r, 'Nothing to rescue: the worktree is clean.'); return 0; }
    out(o, r, `Rescued ${r.committed.length} path(s) to ${r.branch} at ${r.commit.slice(0, 10)}; ${r.left.length} left out (listed in .mergechaos/RESCUE.md). The worktree was not changed.`);
    return 0;
  }
  if (cmd === 'land') {
    const repo = (o.repo || [])[0];
    if (!repo || !o.base || !o.old || !o.new) throw usage('land needs --repo, --base, --old and --new');
    const allow = !!o['allow-collisions'];
    if (o['no-merge-collisions'] && !allow) throw usage('--no-merge-collisions only applies with --allow-collisions');
    const r = land({
      repo: path.resolve(repo), base: o.base, oldRef: o.old, newRef: o.new,
      dryRun: !!o['dry-run'], allowCollisions: allow, mergeCollisions: !o['no-merge-collisions'],
    });
    if (r.stopped) { console.error(`STOP: ${r.stopped}`); return 1; }
    const k = t => r.table.filter(x => x.kind === t).length;
    const where = r.worktree ? ` (working tree ${r.worktree})` : ' (not checked out anywhere: ref only)';
    const head = [`${o['dry-run'] ? 'Dry run: ' : ''}${r.base} ${r.old.slice(0, 10)} -> ${r.new.slice(0, 10)}${where}`,
      `paths: EQUAL ${k('EQUAL')}, SAFE ${k('SAFE')}, COLLIDE ${k('COLLIDE')}`,
      ...r.table.filter(x => x.kind !== 'EQUAL').map(x => `  ${x.kind}\t${x.status}\t${x.path}${x.reason ? ` (${x.reason})` : ''}`)];
    const todo = [
      `What to do: in ${r.worktree}, commit or stash the edits on these paths (or move away what is in the way),`,
      'then run land again with the same --old and --new.',
      'Or pass --allow-collisions to land the SAFE paths now and leave these paths for their owner to resolve.'];
    if (r.refused) {
      const msg = `REFUSED: ${r.collisions.length} path(s) collide with the working tree. Nothing was written and ${r.base} did not move.`;
      out(o, r, [...head, msg, ...todo].join('\n'));
      return 7;
    }
    if (r.dryRun && r.wouldRefuse) {
      out(o, r, [...head, `Without --allow-collisions a real run refuses: ${k('COLLIDE')} path(s) collide.`, ...todo].join('\n'));
      return 0;
    }
    const warn = r.unresolved?.length ? [
      `WARNING: unresolved collisions, files left exactly as they were on disk: ${r.unresolved.join(', ')}`,
      "Their index entries point at the old base: git diff shows the owner's edit, git diff --cached the revert a commit would record.",
      `Until these files are resolved, a plain git commit in ${r.worktree} records a REVERT of the landed change on them.`,
      'Resolve: bring the change in by hand (git diff --cached -R -- <path> is that change as a patch), then git add and commit.'] : [];
    out(o, r, [...head, ...(r.collisions || []).map(c => `  ${c.path}: ${c.result}`), ...warn].join('\n'));
    return r.unresolved?.length ? 8 : 0;
  }
  if (cmd === 'archive') {
    const repo = (o.repo || [])[0];
    if (!repo || !o.branch?.length) throw usage('archive needs --repo and --branch');
    const r = archive(path.resolve(repo), o.branch, { prefix: o.prefix || 'archive/', keepBranch: !!o['keep-branch'] });
    out(o, r, r.map(x => x.skipped ? `${x.branch}: skipped (${x.skipped})` : `${x.branch} -> tag ${x.tag} (${x.commit})${x.removed ? ', branch removed' : ''}`).join('\n'));
    return r.some(x => x.skipped) ? 1 : 0;
  }
  throw usage(`unknown command ${cmd}`);
}

class UsageError extends Error {}
const usage = m => new UsageError(m);
const isMain = process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  try { process.exitCode = main(); } catch (e) {
    console.error(e instanceof UsageError ? `mergechaos: ${e.message}\n\n${HELP}` : `mergechaos: ${e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
