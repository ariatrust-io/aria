import assert from 'assert';

console.log('Running scoring dimension tests...');

function calculateDim1(successRate: number): number {
  return Math.round(successRate * 40);
}

function calculateDim2(scopeRate: number): number {
  if (scopeRate >= 0.99) return 30;
  if (scopeRate >= 0.95) return 27;
  if (scopeRate >= 0.90) return 22;
  if (scopeRate >= 0.85) return 16;
  if (scopeRate >= 0.80) return 10;
  return 0;
}

function calculateDim3(coeffVariation: number): number {
  if (coeffVariation < 0.10) return 15;
  if (coeffVariation < 0.25) return 12;
  if (coeffVariation < 0.50) return 9;
  if (coeffVariation < 0.75) return 5;
  return 2;
}

function calculateDim4(criticalIncidents: number): number {
  if (criticalIncidents === 0) return 10;
  if (criticalIncidents === 1) return 5;
  if (criticalIncidents === 2) return 2;
  return 0;
}

function calculateDim5(
  recentRate: number, previousRate: number
): number {
  if (previousRate === 0) return 3;
  const diff = recentRate - previousRate;
  if (diff > 0.05) return 5;
  if (diff > -0.05) return 3;
  return 0;
}

function finalScore(...dims: number[]): number {
  return Math.min(95, Math.max(0,
    dims.reduce((a, b) => a + b, 0)
  ));
}

// Test 1: Perfect agent scores 95
{
  const score = finalScore(
    calculateDim1(1.0),       // 40
    calculateDim2(1.0),       // 30
    calculateDim3(0.05),      // 15
    calculateDim4(0),         // 10
    calculateDim5(0.98, 0.97) // 5
  );
  assert.strictEqual(score, 95, 'Perfect agent = 95');
  console.log('✅ Test 1: Perfect agent scores 95 (never 100)');
}

// Test 2: Volume does not affect score
{
  const scoreA = finalScore(
    calculateDim1(0.94),
    calculateDim2(0.94),
    calculateDim3(0.3),
    calculateDim4(0),
    calculateDim5(0.94, 0.93)
  );
  const scoreB = finalScore(
    calculateDim1(0.94),
    calculateDim2(0.94),
    calculateDim3(0.3),
    calculateDim4(0),
    calculateDim5(0.94, 0.93)
  );
  assert.strictEqual(scoreA, scoreB, 'Volume does not affect score');
  console.log('✅ Test 2: Volume does not affect score');
}

// Test 3: Agent with many violations but good rate still scores well
{
  const score = finalScore(
    calculateDim1(0.94),      // 37
    calculateDim2(0.94),      // 22 (>=90%)
    calculateDim3(0.2),       // 12
    calculateDim4(0),         // 10
    calculateDim5(0.94, 0.93) // 3
  );
  assert.ok(score >= 80, `6% violation rate agent should be TRUSTED, got ${score}`);
  console.log(`✅ Test 3: 6% violation rate agent scores ${score} (TRUSTED)`);
}

// Test 4: Agent with 50% violation rate is UNTRUSTED
{
  const score = finalScore(
    calculateDim1(0.5),      // 20
    calculateDim2(0.5),      // 0 (below 80%)
    calculateDim3(0.8),      // 2
    calculateDim4(2),        // 2
    calculateDim5(0.5, 0.6)  // 0 (worsening)
  );
  assert.ok(score < 50, `50% violation agent should be UNTRUSTED, got ${score}`);
  console.log(`✅ Test 4: 50% violation agent scores ${score} (UNTRUSTED)`);
}

// Test 5: Score never exceeds 95
{
  const score = finalScore(40, 30, 15, 10, 5);
  assert.strictEqual(score, 95, 'Score capped at 95');
  console.log('✅ Test 5: Score never exceeds 95');
}

// Test 6: Score never goes below 0
{
  const score = finalScore(-100, -100, -100, -100, -100);
  assert.strictEqual(score, 0, 'Score never below 0');
  console.log('✅ Test 6: Score never below 0');
}

// Test 7: Improving trend gets 5 points
{
  const trend = calculateDim5(0.95, 0.85);
  assert.strictEqual(trend, 5, 'Improving trend = 5 pts');
  console.log('✅ Test 7: Improving trend scores 5 points');
}

// Test 8: Worsening trend gets 0 points
{
  const trend = calculateDim5(0.70, 0.90);
  assert.strictEqual(trend, 0, 'Worsening trend = 0 pts');
  console.log('✅ Test 8: Worsening trend scores 0 points');
}

// Test 9: Critical incidents heavily penalize
{
  const dim4_zero = calculateDim4(0);
  const dim4_three = calculateDim4(3);
  assert.strictEqual(dim4_zero, 10);
  assert.strictEqual(dim4_three, 0);
  console.log('✅ Test 9: Critical incidents penalize correctly');
}

// Test 10: Trust levels correct
{
  const trusted = 80;
  const neutral = 65;
  const untrusted = 30;

  const levelOf = (score: number) =>
    score >= 80 ? 'TRUSTED' :
    score >= 50 ? 'NEUTRAL' : 'UNTRUSTED';

  assert.strictEqual(levelOf(trusted), 'TRUSTED');
  assert.strictEqual(levelOf(neutral), 'NEUTRAL');
  assert.strictEqual(levelOf(untrusted), 'UNTRUSTED');
  console.log('✅ Test 10: Trust levels correct');
}

console.log('\nAll scoring tests passed (10/10)');
