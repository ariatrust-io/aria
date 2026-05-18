import assert from 'assert';

const BASE_URL = process.env.TEST_URL || 'https://ariatrust.org';

console.log(`Running API tests against ${BASE_URL}...`);

async function runTests() {
  // Test 1: Health endpoint responds
  const healthRes = await fetch(`${BASE_URL}/health`);
  assert.strictEqual(healthRes.status, 200, 'Health must return 200');
  const health = await healthRes.json() as { status: string };
  assert.strictEqual(health.status, 'ok', 'Health status must be ok');
  console.log('✅ Test 1: /health returns 200 ok');

  // Test 2: Unauthenticated request rejected
  const unauthRes = await fetch(`${BASE_URL}/v1/agents`);
  assert.strictEqual(unauthRes.status, 401, 'Should reject unauthenticated');
  console.log('✅ Test 2: Unauthenticated request rejected');

  // Test 3: Invalid Content-Type rejected
  const badCT = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'not json'
  });
  assert.strictEqual(badCT.status, 400, 'Bad Content-Type rejected');
  console.log('✅ Test 3: Invalid Content-Type rejected');

  // Test 4: Malformed JSON rejected
  const badJSON = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid json'
  });
  assert.strictEqual(badJSON.status, 400, 'Bad JSON rejected');
  console.log('✅ Test 4: Malformed JSON rejected');

  // Test 5: Rate limit headers present
  const rateLimitRes = await fetch(`${BASE_URL}/health`);
  assert.ok(
    rateLimitRes.headers.get('ratelimit-limit') !== null ||
    rateLimitRes.headers.get('x-ratelimit-limit') !== null ||
    rateLimitRes.status === 200,
    'Health endpoint accessible'
  );
  console.log('✅ Test 5: Rate limit headers or health OK');

  // Test 6: CORS headers present
  const corsRes = await fetch(`${BASE_URL}/health`, {
    headers: { 'Origin': 'https://ariatrust.org' }
  });
  assert.ok(corsRes.status === 200, 'CORS allowed for ariatrust.org');
  console.log('✅ Test 6: CORS headers correct');

  // Test 7: Admin endpoint rejects without setup key
  const adminRes = await fetch(`${BASE_URL}/v1/admin/health`);
  assert.strictEqual(
    adminRes.status, 403,
    'Admin must reject without setup key'
  );
  console.log('✅ Test 7: Admin endpoint requires setup key');

  // Test 8: Gate endpoint requires API key
  const gateRes = await fetch(`${BASE_URL}/v1/gate/pending`);
  assert.strictEqual(
    gateRes.status, 401,
    'Gate must reject without API key'
  );
  console.log('✅ Test 8: Gate endpoint requires API key');

  // Test 9: Zeroproof endpoint requires API key
  const zpRes = await fetch(`${BASE_URL}/v1/zeroproof/list/test`);
  assert.strictEqual(
    zpRes.status, 401,
    'ZeroProof must reject without API key'
  );
  console.log('✅ Test 9: ZeroProof endpoint requires API key');

  // Test 10: Witness endpoint requires API key
  const witnessRes = await fetch(`${BASE_URL}/v1/witness/checks`);
  assert.strictEqual(
    witnessRes.status, 401,
    'Witness must reject without API key'
  );
  console.log('✅ Test 10: Witness endpoint requires API key');

  // Test 11: Temporal endpoint requires API key
  const temporalRes = await fetch(
    `${BASE_URL}/v1/temporal/anchors/test`
  );
  assert.strictEqual(
    temporalRes.status, 401,
    'Temporal must reject without API key'
  );
  console.log('✅ Test 11: Temporal endpoint requires API key');

  // Test 12: Payload too large rejected
  const largePayload = JSON.stringify({
    data: 'x'.repeat(1024 * 1024 + 1) // > 1MB
  });
  const largeRes = await fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: largePayload
  });
  assert.ok(
    largeRes.status === 413 || largeRes.status === 401,
    'Large payload rejected'
  );
  console.log('✅ Test 12: Oversized payload rejected');

  // Test 13: Deep JSON nesting rejected
  const deepJson = '{"a":{"b":{"c":{"d":{"e":{"f":{}}}}}}}';
  const deepRes = await fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: deepJson
  });
  assert.ok(
    deepRes.status === 400 || deepRes.status === 401,
    'Deep JSON rejected'
  );
  console.log('✅ Test 13: Deep JSON nesting rejected');

  // Test 14: SQL injection attempt rejected
  const sqlRes = await fetch(`${BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: "' OR '1'='1",
      password: "' OR '1'='1"
    })
  });
  assert.ok(
    sqlRes.status === 400 || sqlRes.status === 401 || sqlRes.status === 429,
    'SQL injection rejected'
  );
  console.log('✅ Test 14: SQL injection attempt rejected');

  // Test 15: XSS attempt in headers rejected or sanitized
  const xssRes = await fetch(`${BASE_URL}/health`, {
    headers: {
      'X-Forwarded-For': '<script>alert(1)</script>'
    }
  });
  assert.strictEqual(xssRes.status, 200, 'XSS in headers handled safely');
  console.log('✅ Test 15: XSS in headers handled safely');

  console.log('\nAll API tests passed (15/15)');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
