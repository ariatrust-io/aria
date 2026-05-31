import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { PUBLIC_PATHS, isPublicPath } from '../config/public-routes.js';

console.log('Running membrane allowlist tests...');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Guardrail 1: anti-drift manifest ─────────────────────────────────────────
// An INDEPENDENT statement of which paths are meant to be public. If PUBLIC_PATHS
// changes without this being updated, the test fails loudly — turning a silent
// production 404 into a caught-before-merge error. Updating both is the
// deliberate "should this be public?" gate.
const EXPECTED_PUBLIC_PATHS = [
  "/", "/app", "/privacy", "/terms", "/acceptable-use", "/cookies",
  "/docs", "/pricing", "/proof", "/reset-password", "/health",
  "/v1/setup", "/v1/agents", "/v1/events", "/v1/auth", "/v1/api-keys",
  "/v1/webhooks", "/v1/gate", "/v1/witness", "/v1/temporal",
  "/v1/zeroproof", "/v1/admin", "/v1/billing", "/v1/proof",
];
assert.deepStrictEqual(
  [...PUBLIC_PATHS].sort(),
  [...EXPECTED_PUBLIC_PATHS].sort(),
  'PUBLIC_PATHS changed without updating the test manifest. If you intend to ' +
  'expose/remove a public route, update EXPECTED_PUBLIC_PATHS too (conscious gate).'
);
console.log('✅ Test 1: allowlist matches anti-drift manifest');

// ── Guardrail 2: membrane uses the shared source, no second hardcoded list ───
const membraneSrc = readFileSync(path.join(__dirname, '..', 'membrane.ts'), 'utf8');
assert.ok(
  /from\s+['"]\.\/config\/public-routes\.js['"]/.test(membraneSrc),
  'membrane.ts must import the allowlist from config/public-routes.js'
);
assert.ok(
  !/const\s+ALLOWED_PATHS\s*=\s*\[/.test(membraneSrc),
  'membrane.ts must NOT redeclare its own ALLOWED_PATHS array (single source of truth)'
);
console.log('✅ Test 2: membrane imports shared allowlist, no duplicate list');

// ── Guardrail 3: every public path is matched (exact + sub-path) ─────────────
for (const p of PUBLIC_PATHS) {
  assert.ok(isPublicPath(p), `exact match must pass: ${p}`);
  if (p !== '/') {
    assert.ok(isPublicPath(p + '/'), `trailing-slash must pass: ${p}/`);
    assert.ok(isPublicPath(p + '/sub/path'), `sub-path must pass: ${p}/sub/path`);
  }
}
console.log('✅ Test 3: all public paths match (exact, trailing slash, sub-paths)');

// ── Guardrail 4: precision — prefix without a "/" boundary must NOT match ────
// This is the polish over a bare startsWith(): no sibling-prefix leakage.
const mustReject = [
  '/proofXYZ',        // would leak via startsWith('/proof')
  '/appearance',      // would leak via startsWith('/app')
  '/healthcheck',     // would leak via startsWith('/health')
  '/v1/agentsX',      // would leak via startsWith('/v1/agents')
  '/v1/proofX',       // would leak via startsWith('/v1/proof')
  '/docsy',
  '/pricingz',
];
for (const p of mustReject) {
  assert.strictEqual(isPublicPath(p), false, `must be rejected (no "/" boundary): ${p}`);
}
console.log('✅ Test 4: sibling-prefix paths correctly rejected');

// ── Guardrail 5: unrelated / probing paths are denied (default-deny) ─────────
const mustDeny = [
  '/admin', '/internal', '/secret', '/.env', '/v1/internal',
  '/wp-admin', '/config', '/v1', '/v1/', '/v1/unknown', '/random',
];
for (const p of mustDeny) {
  assert.strictEqual(isPublicPath(p), false, `must be denied: ${p}`);
}
// "/" must match ONLY itself, never act as a catch-all
assert.strictEqual(isPublicPath('/'), true, 'root must match');
assert.strictEqual(isPublicPath('/anything'), false, 'root must not be a catch-all');
console.log('✅ Test 5: unrelated/probing paths denied; "/" is not a catch-all');

console.log('\nAll membrane allowlist tests passed (5/5)');
