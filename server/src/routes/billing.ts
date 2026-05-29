import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { query } from '../db/pool.js';
import { requireApiKey } from '../middleware/auth.js';

export const billingRouter = Router();

function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PRICE_MAP: Record<string, string | undefined> = {
  professional: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
  enterprise:   process.env.STRIPE_ENTERPRISE_PRICE_ID,
};

function planByPrice(priceId: string): string {
  for (const [plan, id] of Object.entries(PRICE_MAP)) {
    if (id === priceId) return plan;
  }
  return 'free';
}

// POST /v1/billing/checkout — create Stripe Checkout Session
billingRouter.post('/checkout', requireApiKey, async (req, res) => {
  const { plan } = req.body as { plan?: string };

  if (!plan || !PRICE_MAP[plan]) {
    return res.status(400).json({
      error: 'Valid plan required: professional or enterprise',
      code: 'INVALID_PLAN'
    });
  }

  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return res.status(503).json({
      error: 'Billing not configured — contact support',
      code: 'BILLING_NOT_CONFIGURED'
    });
  }

  try {
    const stripe = getStripe();

    const userResult = await query<{
      id: string; email: string; stripe_customer_id: string | null;
    }>(
      `SELECT u.id, u.email, u.stripe_customer_id
       FROM users u
       JOIN api_keys ak ON ak.user_id = u.id
       WHERE ak.id = $1 AND ak.revoked_at IS NULL`,
      [req.apiKeyId]
    );

    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email });
      customerId = customer.id;
      await query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, user.id]
      );
    }

    const appUrl = process.env.APP_URL || 'https://ariatrust.org';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/app?billing=success`,
      cancel_url:  `${appUrl}/app?billing=cancelled`,
      allow_promotion_codes: true,
      metadata: { user_id: user.id, plan },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] POST /checkout error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({
      error: 'Service unavailable', code: 'INTERNAL_ERROR'
    });
  }
});

// GET /v1/billing/portal — Stripe Customer Portal (manage/cancel subscription)
billingRouter.get('/portal', requireApiKey, async (req, res) => {
  try {
    const stripe = getStripe();

    const userResult = await query<{
      id: string; stripe_customer_id: string | null;
    }>(
      `SELECT u.id, u.stripe_customer_id
       FROM users u
       JOIN api_keys ak ON ak.user_id = u.id
       WHERE ak.id = $1 AND ak.revoked_at IS NULL`,
      [req.apiKeyId]
    );

    const user = userResult.rows[0];
    if (!user?.stripe_customer_id) {
      return res.status(400).json({
        error: 'No active subscription found',
        code: 'NO_SUBSCRIPTION'
      });
    }

    const appUrl = process.env.APP_URL || 'https://ariatrust.org';
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${appUrl}/app`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] GET /portal error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({
      error: 'Service unavailable', code: 'INTERNAL_ERROR'
    });
  }
});

// POST /v1/billing/webhook — Stripe events
// Mounted with express.raw() BEFORE express.json() — see index.ts
export async function stripeWebhookHandler(
  req: Request, res: Response
): Promise<void> {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !secret) {
    res.status(400).json({ error: 'Missing Stripe signature' });
    return;
  }

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      req.body as Buffer, sig, secret
    );
  } catch (err) {
    console.error('[billing] Webhook signature failed:',
      err instanceof Error ? err.message : 'Unknown');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (
          session.mode === 'subscription' &&
          session.subscription &&
          session.metadata?.user_id
        ) {
          const plan = session.metadata.plan ?? 'professional';
          await query(
            `UPDATE users
             SET plan = $1, plan_started_at = NOW(),
                 stripe_subscription_id = $2, stripe_price_id = $3
             WHERE id = $4`,
            [plan, session.subscription,
             (session as any).line_items?.data?.[0]?.price?.id ?? null,
             session.metadata.user_id]
          );
          console.log(`[billing] Plan activated: ${plan} → user ${session.metadata.user_id}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const priceId = sub.items.data[0]?.price.id;
        const plan = priceId ? planByPrice(priceId) : 'free';

        if (sub.status === 'active' || sub.status === 'trialing') {
          await query(
            `UPDATE users
             SET plan = $1, plan_started_at = NOW(),
                 stripe_subscription_id = $2, stripe_price_id = $3
             WHERE stripe_customer_id = $4`,
            [plan, sub.id, priceId ?? null, sub.customer as string]
          );
          console.log(`[billing] Subscription updated: ${plan} for customer ${sub.customer}`);
        } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
          console.warn(`[billing] Payment issue for customer ${sub.customer}: ${sub.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await query(
          `UPDATE users
           SET plan = 'free', stripe_subscription_id = NULL, stripe_price_id = NULL
           WHERE stripe_customer_id = $1`,
          [sub.customer as string]
        );
        console.log(`[billing] Subscription cancelled → free: ${sub.customer}`);
        break;
      }

    }

    res.json({ received: true });
  } catch (err) {
    console.error('[billing] Webhook processing error:',
      err instanceof Error ? err.message : 'Unknown');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}
