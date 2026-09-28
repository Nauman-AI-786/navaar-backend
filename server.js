require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Checks the login token sent by the browser and works out who the caller really is.
// Every route below that touches user data uses req.user.id, never an id sent in the request.
async function requireUser(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please sign in first' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return res.status(401).json({ error: 'Session expired, please sign in again' });
  req.user = data.user;
  next();
}

const LS_API = 'https://api.lemonsqueezy.com/v1';
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID;
const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

// LemonSqueezy "variant" IDs (each price/billing cycle is one variant)
const VARIANT_IDS = {
  creator_monthly: process.env.LEMONSQUEEZY_VARIANT_CREATOR_MONTHLY,
  creator_annual: process.env.LEMONSQUEEZY_VARIANT_CREATOR_ANNUAL,
  studio_monthly: process.env.LEMONSQUEEZY_VARIANT_STUDIO_MONTHLY,
  studio_annual: process.env.LEMONSQUEEZY_VARIANT_STUDIO_ANNUAL,
};

const STATUS_MAP = {
  active: 'active',
  on_trial: 'active',
  paused: 'inactive',
  past_due: 'past_due',
  unpaid: 'past_due',
  cancelled: 'canceled',
  expired: 'canceled',
};

const SUBSCRIPTION_EVENTS = [
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
];

// Note: the columns are still named stripe_customer_id / stripe_subscription_id
// in the database. We store the LemonSqueezy customer and subscription IDs in them.
async function saveSubscription(userId, fields) {
  const { data: existing, error: findError } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { error } = await supabase.from('subscriptions').update(fields).eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('subscriptions').insert({ user_id: userId, ...fields });
    if (error) throw error;
  }
}

// --- Webhook needs the raw body for signature checking, so it's registered BEFORE express.json() ---
app.post('/api/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  if (!LS_WEBHOOK_SECRET) return res.status(503).send('Webhook secret not configured');

  const signature = String(req.headers['x-signature'] || '');
  const digest = crypto.createHmac('sha256', LS_WEBHOOK_SECRET).update(req.body).digest('hex');
  const valid =
    signature.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  if (!valid) {
    console.error('Webhook signature check failed');
    return res.status(400).send('Invalid signature');
  }

  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const eventName = payload.meta && payload.meta.event_name;
    if (!SUBSCRIPTION_EVENTS.includes(eventName)) return res.json({ received: true });

    const custom = (payload.meta && payload.meta.custom_data) || {};
    const sub = payload.data;
    const attrs = sub.attributes || {};
    const subscriptionId = String(sub.id);

    let userId = custom.user_id;
    if (!userId) {
      // Fall back to finding the user by the stored subscription id
      const { data: row } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_subscription_id', subscriptionId)
        .maybeSingle();
      userId = row && row.user_id;
    }
    if (!userId) {
      console.error('Webhook: could not work out which user this belongs to');
      return res.json({ received: true });
    }

    const fields = {
      status: STATUS_MAP[attrs.status] || 'inactive',
      stripe_customer_id: attrs.customer_id ? String(attrs.customer_id) : null,
      stripe_subscription_id: subscriptionId,
      current_period_end: attrs.ends_at || attrs.renews_at || null,
      updated_at: new Date().toISOString(),
    };
    if (custom.plan) fields.plan = custom.plan;

    await saveSubscription(userId, fields);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Create a LemonSqueezy checkout for a given plan
// body: { plan: 'creator'|'studio', billing: 'monthly'|'annual' }  (user comes from the login token)
app.post('/api/checkout', requireUser, async (req, res) => {
  try {
    if (!LS_API_KEY || !LS_STORE_ID) {
      return res.status(503).json({ error: 'Payments are not set up yet' });
    }
    const { plan, billing } = req.body;
    const userId = req.user.id;
    const variantId = VARIANT_IDS[`${plan}_${billing}`];
    if (!variantId) return res.status(400).json({ error: 'Unknown plan or billing cycle' });

    const response = await fetch(`${LS_API}/checkouts`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${LS_API_KEY}`,
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { custom: { user_id: userId, plan } },
            product_options: { redirect_url: process.env.CLIENT_SUCCESS_URL },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(LS_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(variantId) } },
          },
        },
      }),
    });

    const json = await response.json();
    if (!response.ok) {
      console.error('LemonSqueezy checkout error:', JSON.stringify(json));
      return res.status(502).json({ error: 'Could not start checkout' });
    }
    res.json({ url: json.data.attributes.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Get the caller's current plan/status
app.get('/api/subscription/:userId', requireUser, async (req, res) => {
  if (req.params.userId !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { plan: 'free', status: 'inactive' });
});

// Saved-project limit for each plan (null = unlimited). Keep in step with the pricing section on the website.
const PROJECT_LIMITS = { free: 5, creator: 100, studio: null };

// A user only gets their paid plan while the subscription is active; otherwise they are on Free.
async function getUserPlan(userId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data && data.status === 'active' && Object.prototype.hasOwnProperty.call(PROJECT_LIMITS, data.plan)) {
    return data.plan;
  }
  return 'free';
}

// Save a project (poetry/lyrics + style choices)
app.post('/api/projects', requireUser, async (req, res) => {
  const { text, mood, typography, background, voice } = req.body;
  const userId = req.user.id;
  if (!text) return res.status(400).json({ error: 'text is required' });

  try {
    const plan = await getUserPlan(userId);
    const limit = PROJECT_LIMITS[plan];
    if (limit !== null) {
      const { count, error: countError } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (countError) throw countError;
      if (count >= limit) {
        return res.status(403).json({
          error: `Your ${plan} plan allows up to ${limit} saved projects. Delete one or upgrade to save more.`,
          code: 'project_limit_reached',
          plan,
          limit,
        });
      }
    }
  } catch (err) {
    console.error('Project limit check error:', err);
    return res.status(500).json({ error: 'Could not save the project right now' });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ user_id: userId, text, mood, typography, background, voice })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// List a user's saved projects
app.get('/api/projects/:userId', requireUser, async (req, res) => {
  if (req.params.userId !== req.user.id) return res.status(403).json({ error: 'Not allowed' });
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete a saved project
app.delete('/api/projects/:id', requireUser, async (req, res) => {
  const { error } = await supabase.from('projects').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Navaar backend running on port ${port}`));
