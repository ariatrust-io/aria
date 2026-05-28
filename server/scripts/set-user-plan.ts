const VALID_PLANS = ['free', 'professional', 'enterprise'] as const;

type Plan = (typeof VALID_PLANS)[number];

function usage(): void {
  console.error('Usage: npm run set-user-plan -- <email> <plan>');
  console.error('Example: npm run set-user-plan -- chanimol3149@gmail.com enterprise');
  console.error('Requires DATABASE_URL to be set in the environment.');
}

async function getQuery() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required to connect to the database.');
    process.exit(1);
  }

  const { query } = await import('../src/db/pool.js');
  return query;
}

async function main(): Promise<void> {
  const [, , email, plan] = process.argv;

  if (!email || !plan) {
    usage();
    process.exit(1);
  }

  if (!VALID_PLANS.includes(plan as Plan)) {
    console.error(`Invalid plan: ${plan}`);
    console.error(`Valid plans: ${VALID_PLANS.join(', ')}`);
    process.exit(1);
  }

  const query = await getQuery();

  const userResult = await query(`
    SELECT id, plan
    FROM users
    WHERE email = $1
  `, [email]);

  if (userResult.rowCount === 0) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const user = userResult.rows[0] as { id: string; plan: string };

  if (user.plan === plan) {
    console.log(`User ${email} already has plan '${plan}'.`);
    return;
  }

  await query(`
    UPDATE users
    SET plan = $1,
        plan_started_at = NOW()
    WHERE id = $2
  `, [plan, user.id]);

  console.log(`Updated user ${email} (${user.id}) from '${user.plan}' to '${plan}'.`);
}

main().catch((err) => {
  console.error('Error updating user plan:', err);
  process.exit(1);
});
