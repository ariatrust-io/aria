import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { query } from '../db/pool.js';
import { requireApiKey } from '../middleware/auth.js';

export const billingRouter = Router();

const LS_API = 'https://api.lemonsqueezy.com/v1';

function lsHeaders() {
  const key = process.env.LEMONSQUEEZY_API_KEY;
  if (!key) throw new Error('LEMONSQUEEZY_API_KEY not configured');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/vnd.api+json',
    'Accept': 'application/vnd.api+json',
  };
}

const VARIANT_MAP: Record<string, string | undefined> = {
  professional: process.env.LEMONSQUEEZY_PROFESSIONAL_VARIANT_ID,
  business:     process.env.LEMONSQUEEZY_BUSINESS_VARIANT_ID,
  // enterprise is sales-assisted — no automated checkout
};

function planByVariant(variantId: string | number): string {
  const id = String(variantId);
  for (const [plan, vid] of Object.entries(VARIANT_MAP)) {
    if (vid === id) return plan;
  }
  return 'free';
}

// POST /v1/billing/checkout — create Lemon Squeezy checkout
billingRouter.post('/checkout', requireApiKey, async (req, res) => {
  const { plan } = req.body as { plan?: string };

  if (plan === 'enterprise') {
    return res.status(400).json({
      error: 'Enterprise requires a custom agreement. Contact dhdez3149@gmail.com',
      code: 'ENTERPRISE_CONTACT_SALES'
    });
  }

  if (!plan || !VARIANT_MAP[plan]) {
    return res.status(400).json({
      error: 'Valid plan required: professional or business',
      code: 'INVALID_PLAN'
    });
  }

  const variantId = VARIANT_MAP[plan];
  const storeId   = process.env.LEMONSQUEEZY_STORE_ID;

  if (!variantId || !storeId) {
    return res.status(503).json({
      error: 'Billing not configured — contact support',
      code: 'BILLING_NOT_CONFIGURED'
    });
  }

  try {
    const userResult = await query<{ id: string; email: string }>(
      `SELECT u.id, u.email
       FROM users u
       JOIN api_keys ak ON ak.user_id = u.id
       WHERE ak.id = $1 AND ak.revoked_at IS NULL`,
      [req.apiKeyId]
    );

    const user = userResult.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const appUrl = process.env.APP_URL || 'https://ariatrust.org';

    const response = await fetch(`${LS_API}/checkouts`, {
      method: 'POST',
      headers: lsHeaders(),
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user.email,
              custom: { user_id: user.id, plan },
            },
            product_options: {
              redirect_url: `${appUrl}/app?billing=success`,
            },
          },
          relationships: {
            store:   { data: { type: 'stores',   id: storeId   } },
            variant: { data: { type: 'variants', id: variantId } },
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[billing] LS checkout API error:', err);
      return res.status(500).json({
        error: 'Could not create checkout', code: 'CHECKOUT_ERROR'
      });
    }

    const data = await response.json() as {
      data: { attributes: { url: string } }
    };

    return res.json({ url: data.data.attributes.url });
  } catch (err) {
    console.error('[billing] POST /checkout error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({
      error: 'Service unavailable', code: 'INTERNAL_ERROR'
    });
  }
});

// GET /v1/billing/portal — get customer portal URL
billingRouter.get('/portal', requireApiKey, async (req, res) => {
  try {
    const userResult = await query<{
      id: string; lemonsqueezy_subscription_id: string | null;
    }>(
      `SELECT u.id, u.lemonsqueezy_subscription_id
       FROM users u
       JOIN api_keys ak ON ak.user_id = u.id
       WHERE ak.id = $1 AND ak.revoked_at IS NULL`,
      [req.apiKeyId]
    );

    const user = userResult.rows[0];
    if (!user?.lemonsqueezy_subscription_id) {
      return res.status(400).json({
        error: 'No active subscription found',
        code: 'NO_SUBSCRIPTION'
      });
    }

    const response = await fetch(
      `${LS_API}/subscriptions/${user.lemonsqueezy_subscription_id}`,
      { headers: lsHeaders() }
    );

    if (!response.ok) {
      return res.status(500).json({
        error: 'Could not get portal URL', code: 'PORTAL_ERROR'
      });
    }

    const data = await response.json() as {
      data: { attributes: { urls: { customer_portal: string } } }
    };

    return res.json({ url: data.data.attributes.urls.customer_portal });
  } catch (err) {
    console.error('[billing] GET /portal error:',
      err instanceof Error ? err.message : 'Unknown');
    return res.status(500).json({
      error: 'Service unavailable', code: 'INTERNAL_ERROR'
    });
  }
});

// POST /v1/billing/webhook — Lemon Squeezy events (raw body, no auth)
export async function lsWebhookHandler(
  req: Request, res: Response
): Promise<void> {
  const secret    = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'] as string | undefined;

  if (!secret || !signature) {
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  const digest = createHmac('sha256', secret)
    .update(req.body as Buffer)
    .digest('hex');

  try {
    if (!timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload  = JSON.parse((req.body as Buffer).toString()) as Record<string, any>;
  const event    = payload.meta?.event_name as string;
  const attrs    = payload.data?.attributes ?? {};
  const subId    = String(payload.data?.id ?? '');

  try {
    switch (event) {

      case 'subscription_created': {
        const userId     = payload.meta?.custom_data?.user_id as string | undefined;
        const plan       = (payload.meta?.custom_data?.plan as string) ?? 'professional';
        const customerId = String(attrs.customer_id ?? '');
        const variantId  = String(attrs.variant_id  ?? '');

        if (userId) {
          // Authenticated checkout from dashboard — update by user id
          await query(
            `UPDATE users
             SET plan = $1, plan_started_at = NOW(),
                 lemonsqueezy_subscription_id = $2,
                 lemonsqueezy_customer_id     = $3,
                 lemonsqueezy_variant_id      = $4
             WHERE id = $5`,
            [plan, subId, customerId, variantId, userId]
          );
          console.log(`[billing] Plan activated: ${plan} → user ${userId}`);
        } else {
          // Anonymous checkout from pricing page — upsert by email
          const email = (attrs.user_email as string | undefined)?.toLowerCase();
          if (email) {
            await query(
              `INSERT INTO users (email, name, plan, plan_started_at,
                                  lemonsqueezy_subscription_id, lemonsqueezy_customer_id, lemonsqueezy_variant_id)
               VALUES ($1, COALESCE($2, 'User'), $3, NOW(), $4, $5, $6)
               ON CONFLICT (email) DO UPDATE SET
                 plan                         = EXCLUDED.plan,
                 plan_started_at              = NOW(),
                 lemonsqueezy_subscription_id = EXCLUDED.lemonsqueezy_subscription_id,
                 lemonsqueezy_customer_id     = EXCLUDED.lemonsqueezy_customer_id,
                 lemonsqueezy_variant_id      = EXCLUDED.lemonsqueezy_variant_id`,
              [email, attrs.user_name as string | undefined, plan, subId, customerId, variantId]
            );
            console.log(`[billing] Plan activated (by email): ${plan} → ${email}`);
          }
        }
        break;
      }

      case 'subscription_updated': {
        const status    = attrs.status as string;
        const variantId = String(attrs.variant_id ?? '');
        const plan      = planByVariant(variantId);

        if (status === 'active') {
          await query(
            `UPDATE users
             SET plan = $1, lemonsqueezy_variant_id = $2
             WHERE lemonsqueezy_subscription_id = $3`,
            [plan, variantId, subId]
          );
          console.log(`[billing] Subscription updated: ${plan} (${subId})`);
        } else if (status === 'past_due' || status === 'unpaid') {
          console.warn(`[billing] Payment issue on ${subId}: ${status}`);
        }
        break;
      }

      case 'subscription_cancelled':
      case 'subscription_expired': {
        await query(
          `UPDATE users
           SET plan = 'free',
               lemonsqueezy_subscription_id = NULL,
               lemonsqueezy_variant_id      = NULL
           WHERE lemonsqueezy_subscription_id = $1`,
          [subId]
        );
        console.log(`[billing] ${event} → downgraded to free (${subId})`);
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
