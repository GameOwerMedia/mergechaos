// Table-driven tests for safety.mjs: private file names and secret-looking content (shared by premerge and mergechaos).
// Every credential below is fake and assembled at run time, so secret scanners do not flag this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretKinds, scanDiffForSecrets, isPrivateFile, scanBuffer, utf16Kind } from '../skills/mergechaos/scripts/safety.mjs';

const V = 'q7Rk' + 'Lm2Px9Tz4Wb8Yc';                 // 18 characters, looks random
const LONG = V + V;                                  // 36 characters
const at = '@';

const SECRET_LINES = [
  // SCREAMING_SNAKE and camelCase names, quoted values
  [`OPENAI_API_KEY="${V}"`, 'assigned secret'],
  [`GITHUB_TOKEN="${V}"`, 'assigned secret'],
  [`AWS_SECRET_ACCESS_KEY="${V}"`, 'assigned secret'],
  [`const dbPassword = '${V}';`, 'assigned secret'],
  [`  jwtSecret: "${V}",`, 'assigned secret'],
  [`let authToken = "${V}"`, 'assigned secret'],
  [`stripeApiKey: '${V}'`, 'assigned secret'],
  [`"client_secret": "${V}"`, 'assigned secret'],
  [`secret_key_base = "${V}"`, 'assigned secret'],
  // unquoted: dotenv, shell export, YAML
  [`export TOKEN=${V}`, 'assigned secret'],
  [`DB_PASSWORD=${V}`, 'assigned secret'],
  ['export AWS_SECRET_' + 'ACCESS_KEY=' + 'wJalr' + 'XUtnFEMI/K7MDENG/' + V + 'EXAMPLEKEY', 'assigned secret'],
  [`aws_secret_access_key = ${V}`, 'assigned secret'],
  [`  password: ${V}`, 'assigned secret'],
  // known prefixes
  ['sk' + '_live_' + V, 'provider key'],
  ['key = sk' + '-proj-' + LONG, 'provider key'],
  ['gh' + 'p_' + LONG, 'provider key'],
  ['AK' + 'IA' + 'ABCDEFGHIJKLMNOP', 'provider key'],
  ['xo' + 'xb-' + '1234567890-' + V, 'provider key'],
  ['AI' + 'za' + LONG, 'provider key'],
  // other shapes
  ['Authorization: Bearer ' + LONG, 'bearer token'],
  ['postgres://app:' + V + at + 'db.internal:5432/shop', 'URL credentials'],
  ['ey' + 'J' + V + '.ey' + 'J' + V + '.' + V, 'JSON web token'],
  ['-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'private key'],
  ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'private key'],
  ['https://hooks.slack.com/services/' + 'T0123ABC/B0456DEF/' + V, 'webhook URL'],
];

const CLEAN_LINES = [
  'const tokenizer = "bert-base-uncased-tokenizer";',
  'password: ${{ secrets.DB_PASSWORD }}',
  'const authToken = req.headers.authorization;',
  'TOKEN=$GITHUB_TOKEN',
  'api_key = os.environ["API_KEY"]',
  'password = ""',
  'const max_tokens = 4096;',
  'Authorization: Bearer <token>',
  'url = "postgres://user:${PASSWORD}' + at + 'localhost/db"',
  'https://example.com/docs/tokens',
  'SECRET_KEY=changeme-in-production',
  'password: "<your password here>"',
  'export API_KEY=$(cat ~/.key)',
  'apiKey: process.env.STRIPE_API_KEY',
];

for (const [line, kind] of SECRET_LINES) {
  test(`secret detected (${kind}): ${line.replace(V, '<value>').replace(V, '<value>').slice(0, 40)}`, () => {
    assert.ok(secretKinds(line).includes(kind), `${kind} expected, got ${JSON.stringify(secretKinds(line))}`);
  });
}
for (const line of CLEAN_LINES) {
  test(`no secret: ${line}`, () => assert.deepEqual(secretKinds(line), []));
}

test('scanDiffForSecrets: only added lines inside hunks; a line starting with ++ is content, not a header', () => {
  const diff = [
    'diff --git a/app.js b/app.js', '--- a/app.js', '+++ b/app.js', '@@ -1,2 +1,3 @@',
    ` const a = 1;`, `++ const token = "${V}"`, `-const old = "${V}";`,
    'diff --git a/gone.txt b/gone.txt', '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', `-password=${V}`,
    'diff --git a/new.env.md b/new.env.md', '--- /dev/null', '+++ b/notes.md', '@@ -0,0 +1 @@', `+export TOKEN=${V}`,
  ].join('\n');
  assert.deepEqual(scanDiffForSecrets(diff), [{ kind: 'assigned secret', file: 'app.js' }, { kind: 'assigned secret', file: 'notes.md' }]);
});

const PRIVATE = [
  '.env', '.ENV', 'app/.env.production', 'prod.env', 'config/app.env', 'env.production', '.envrc', 'notes.local.md', 'PRZ.local.json',
  'certs/server.pem', 'tls.key', 'store.p12', 'release.jks', 'android.keystore', 'putty.ppk', 'AuthKey_ABC.p8', 'vault.kdbx',
  'terraform.tfstate', 'infra/terraform.tfstate.backup', 'prod.tfvars', '.ssh/id_rsa', 'id_rsa.bak', 'my_id_ed25519', 'id_ecdsa',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.aws/credentials', 'Credentials.JSON', 'gcp/service-account.json',
  'service_account_prod.json', '.docker/config.json', '.pgpass', 'secrets.json', 'config/secrets.yaml', '.dev.vars', 'client_secret_123.json',
];
const PUBLIC = ['src/env.js', 'docs/local.md', 'keys.md', '.env.example', 'app/.env.sample', 'config/.env.template', '.ssh/id_rsa.pub',
  'src/environment.ts', 'docs/credentials-guide.md', 'docker/config.json', 'tokenizer.json', 'src/keyboard.ts'];

test('isPrivateFile: every documented private name is refused', () => {
  for (const p of PRIVATE) assert.ok(isPrivateFile(p), p);
});
test('isPrivateFile: ordinary and template files pass', () => {
  for (const p of PUBLIC) assert.ok(!isPrivateFile(p), p);
});

test('scanBuffer: UTF-16 (with and without BOM) and binary content are scanned', () => {
  const line = `password=${V}\n`;
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
  const leNoBom = Buffer.from('notes\n' + line, 'utf16le');
  const be = Buffer.from(Buffer.from(line, 'utf16le')); be.swap16();
  assert.equal(utf16Kind(le), 'le'); assert.equal(utf16Kind(leNoBom), 'le');
  for (const b of [le, leNoBom, Buffer.concat([Buffer.from([0xfe, 0xff]), be])]) assert.deepEqual(scanBuffer(b), ['assigned secret']);
  assert.deepEqual(scanBuffer(Buffer.concat([Buffer.from([0, 1, 2, 0, 10]), Buffer.from(line)])), ['assigned secret']);
  assert.deepEqual(scanBuffer(Buffer.from('plain text\n', 'utf16le')), []);
});
