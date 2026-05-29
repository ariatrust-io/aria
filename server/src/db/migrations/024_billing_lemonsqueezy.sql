ALTER TABLE users RENAME COLUMN stripe_customer_id      TO lemonsqueezy_customer_id;
ALTER TABLE users RENAME COLUMN stripe_subscription_id  TO lemonsqueezy_subscription_id;
ALTER TABLE users RENAME COLUMN stripe_price_id         TO lemonsqueezy_variant_id;

DROP INDEX IF EXISTS idx_users_stripe_customer_id;

CREATE INDEX IF NOT EXISTS idx_users_lemonsqueezy_customer_id
  ON users(lemonsqueezy_customer_id)
  WHERE lemonsqueezy_customer_id IS NOT NULL;
