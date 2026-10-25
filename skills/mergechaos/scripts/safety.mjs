// Private-file names and secret-looking content: the shared safety net of premerge and mergechaos.
// The same file ships in both projects, so each skill folder stays self-contained.
// Best effort, not a guarantee: patterns reduce accidents; run a dedicated secret scanner as well.

/** File names that are never committed. Matched against the path with forward slashes, case-insensitive. */
export const PRIVATE_FILE = new RegExp('(^|/)(' + [
  '\\.env(\\.[^/]*)?', '[^/]+\\.env', 'env\\.(prod|production|dev|development|local|stage|staging|test)[^/]*', '\\.envrc', '\\.dev\\.vars',
  '[^/]*\\.local\\.[^/]+',
  '[^/]*\\.(pem|key|p12|pfx|jks|keystore|ppk|p8|kdbx|tfvars)',
  '[^/]*\\.tfstate(\\.[^/]*)?',
  '[^/]*id_(rsa|dsa|ecdsa|ed25519)[^/]*',
  '\\.npmrc', '\\.pypirc', '\\.netrc', '\\.pgpass', '\\.git-credentials', '\\.htpasswd',
  'credentials', 'credentials[^/]*\\.json', 'client_secret[^/]*\\.json', 'service[-_]?account[^/]*\\.json',
  'secrets?\\.(json|ya?ml|toml|env|ini)', '\\.docker/config\\.json',
].join('|') + ')$', 'i');
/** Public counterparts that look private by name: templates and public keys. */
const PUBLIC_OK = /(\.pub|(^|\/|\.)env\.(example|sample|template|dist)|(^|\/)(example|sample)\.env)$/i;
export const isPrivateFile = p => PRIVATE_FILE.test(p) && !PUBLIC_OK.test(p);

const NAME = '[A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|credential|'
  + 'private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]*';
/** Whole values that are obviously not real: templates, variables, masks. */
const PLACEHOLDER = /^(<[^>]*>|\$\{?[A-Za-z0-9_]*\}?|\{\{.*\}\}|%[A-Za-z0-9_]+%|x{6,}|\*{6,}|(your|my)[_-].*|changeme.*|example|placeholder|dummy|redacted)$/i;
const NOT_LITERAL = /^(process\.env|os\.environ|os\.getenv|env\.|secrets\.|vars\.|config\.|settings\.|true|false|null|none|undefined)/i;

/** [kind, pattern, optional value check]; the check gets (value, name). */
export const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ['provider key', new RegExp('(?<![A-Za-z0-9])(' + [
    'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}', '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}', 'AIza[0-9A-Za-z_-]{30,}',
    'gh[pousr]_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{30,}', 'xox[abposr]-[A-Za-z0-9-]{10,}', '(?:AKIA|ASIA)[0-9A-Z]{16}',
    'hf_[A-Za-z0-9]{30,}', 'glpat-[A-Za-z0-9_-]{20,}', 'npm_[A-Za-z0-9]{36}',
  ].join('|') + ')')],
  ['webhook URL', /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/],
  ['JSON web token', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer token', /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/i, v => !PLACEHOLDER.test(v)],
  ['URL credentials', /[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s:/@'"]+)@/i, v => !PLACEHOLDER.test(v) && v.length >= 4],
  // quoted literal assigned to a sensitive name, anywhere on the line (code, JSON, YAML, dotenv)
  ['assigned secret', new RegExp(`(${NAME})["']?\\s*(?::=|=>|[:=])\\s*["']([^"'\\s]{8,})["']`, 'i'),
    (v, name) => !/tokeniz/i.test(name) && !PLACEHOLDER.test(v)],
  // unquoted literal on a line that is only an assignment: dotenv, shell `export`, YAML, INI
  ['assigned secret', new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*[:=]\\s*([^\\s"'#;]{8,})\\s*(?:#.*)?$`, 'i'),
    (v, name) => !/tokeniz/i.test(name) && !PLACEHOLDER.test(v) && !NOT_LITERAL.test(v) && !/[()[\]{}$]/.test(v)],
];

/** Kinds of secret-looking content in one line (never the value). */
export function secretKinds(line) {
  const kinds = new Set();
  for (const [kind, re, check] of SECRET_RULES) {
    const m = line.match(re);
    if (!m) continue;
    const value = m.length > 2 ? m[m.length - 1] : m[1];
    if (!check || check(value, m[1])) kinds.add(kind);
  }
  return [...kinds];
}

/** UTF-16 text: a byte-order mark, or NUL in most odd (LE) or even (BE) positions of the first bytes. */
export function utf16Kind(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'be';
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 8) return null;
  let odd = 0, even = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
  if (odd > n / 2 * 0.6 && even < n / 2 * 0.1) return 'le';
  if (even > n / 2 * 0.6 && odd < n / 2 * 0.1) return 'be';
  return null;
}

/** Text to scan from any file content: UTF-16 is decoded, everything else is read byte for byte (latin1). */
export function textForScan(buf) {
  const k = utf16Kind(buf);
  if (k === 'le') return buf.toString('utf16le');
  if (k === 'be') { const s = Buffer.from(buf.subarray(0, buf.length & ~1)); s.swap16(); return s.toString('utf16le'); }
  return buf.toString('latin1');
}

/** Kinds found anywhere in a file's content (binary-safe). */
export function scanBuffer(buf) {
  const kinds = new Set();
  for (const l of textForScan(buf).split(/\r?\n/)) for (const k of secretKinds(l)) kinds.add(k);
  return [...kinds];
}

/**
 * Secret-looking lines added by a unified diff (run git diff with --text so binary files are scanned too).
 * Only lines inside hunks count; `+++` is a file header only before the first `@@` of each file.
 */
export function scanDiffForSecrets(diff) {
  const hits = []; let file = null, inHunk = false;
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; file = null; continue; }
    if (!inHunk) {
      if (l.startsWith('+++ ')) { const f = l.slice(4); if (f !== '/dev/null') file = f.replace(/^b\//, ''); continue; }
      if (l.startsWith('--- ')) { if (!file) file = l.slice(4).replace(/^a\//, ''); continue; }
      if (l.startsWith('@@')) inHunk = true;
      continue;
    }
    if (l.startsWith('@@') || !l.startsWith('+')) continue;
    for (const kind of secretKinds(l.slice(1))) hits.push({ kind, file });
  }
  return hits;
}
