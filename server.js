require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Checks the login token sent by the browser and works out who the caller really is.
async function requireUser(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Please sign in first' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data || !data.user) {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }

  req.user = data.user;
  next();
}


// ============================================================
// LEMON SQUEEZY
// ============================================================

const LS_API = 'https://api.lemonsqueezy.com/v1';
const LS_API_KEY = process.env.LEMONSQUEEZY_API_KEY;
const LS_STORE_ID = process.env.LEMONSQUEEZY_STORE_ID;
const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;

const VARIANT_IDS = {
  creator_monthly: process.env.LEMONSQUEEZY_VARIANT_CREATOR_MONTHLY,
  creator_annual: process.env.LEMONSQUEEZY_VARIANT_CREATOR_ANNUAL,
  studio_monthly: process.env.LEMONSQUEEZY_VARIANT_STUDIO_MONTHLY,
  studio_annual: process.env.LEMONSQUEEZY_VARIANT_STUDIO_ANNUAL
};

const STATUS_MAP = {
  active: 'active',
  on_trial: 'active',
  paused: 'inactive',
  past_due: 'past_due',
  unpaid: 'past_due',
  cancelled: 'canceled',
  expired: 'canceled'
};

const SUBSCRIPTION_EVENTS = [
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused'
];


// ============================================================
// SAVE SUBSCRIPTION
// ============================================================

async function saveSubscription(userId, fields) {
  const { data: existing, error: findError } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (findError) throw findError;

  if (existing) {
    const { error } = await supabase
      .from('subscriptions')
      .update(fields)
      .eq('user_id', userId);

    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('subscriptions')
      .insert({ user_id: userId, ...fields });

    if (error) throw error;
  }
}


// ============================================================
// LEMON SQUEEZY WEBHOOK
// ============================================================

app.post(
  '/api/webhook',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    if (!LS_WEBHOOK_SECRET) {
      return res.status(503).send('Webhook secret not configured');
    }

    const signature = String(req.headers['x-signature'] || '');

    const digest = crypto
      .createHmac('sha256', LS_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

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

      if (!SUBSCRIPTION_EVENTS.includes(eventName)) {
        return res.json({ received: true });
      }

      const custom = (payload.meta && payload.meta.custom_data) || {};

      const sub = payload.data;
      const attrs = sub.attributes || {};
      const subscriptionId = String(sub.id);

      let userId = custom.user_id;

      if (!userId) {
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
        updated_at: new Date().toISOString()
      };

      if (custom.plan) {
        fields.plan = custom.plan;
      }

      await saveSubscription(userId, fields);

      res.json({ received: true });

    } catch (err) {
      console.error('Webhook handling error:', err);
      res.status(500).send('Webhook handler failed');
    }
  }
);


// ============================================================
// JSON BODY
// ============================================================

app.use(express.json());


app.use('/api/ai', require('./ai-routes'));

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});


// ============================================================
// CHECKOUT
// ============================================================

app.post(
  '/api/checkout',
  requireUser,
  async (req, res) => {
    try {
      if (!LS_API_KEY || !LS_STORE_ID) {
        return res.status(503).json({ error: 'Payments are not set up yet' });
      }

      const { plan, billing } = req.body;

      const userId = req.user.id;

      const variantId = VARIANT_IDS[`${plan}_${billing}`];

      if (!variantId) {
        return res.status(400).json({ error: 'Unknown plan or billing cycle' });
      }

      const response = await fetch(`${LS_API}/checkouts`, {
        method: 'POST',

        headers: {
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
          Authorization: `Bearer ${LS_API_KEY}`
        },

        body: JSON.stringify({
          data: {
            type: 'checkouts',

            attributes: {
              checkout_data: {
                custom: {
                  user_id: userId,
                  plan
                }
              },

              product_options: {
                redirect_url: process.env.CLIENT_SUCCESS_URL
              }
            },

            relationships: {
              store: {
                data: {
                  type: 'stores',
                  id: String(LS_STORE_ID)
                }
              },

              variant: {
                data: {
                  type: 'variants',
                  id: String(variantId)
                }
              }
            }
          }
        })
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
  }
);


// ============================================================
// GET SUBSCRIPTION
// ============================================================

app.get(
  '/api/subscription/:userId',
  requireUser,
  async (req, res) => {

    if (req.params.userId !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', req.params.userId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || { plan: 'free', status: 'inactive' });
  }
);


// ============================================================
// FEEDBACK SYSTEM
// ============================================================

// The website form sends: name, email, category, rating, message, website
// (older clients may send "type" instead of "category").
// Rating 0 means the visitor did not pick any stars.

app.post(
  '/api/feedback',
  async (req, res) => {

    try {

      const name = String(req.body.name || '').trim();

      const email = String(req.body.email || '').trim().toLowerCase();

      const type = String(
        req.body.type || req.body.category || 'General'
      ).trim();

      const rating = Number(req.body.rating || 0);

      const message = String(req.body.message || '').trim();

      // The form already requires the consent checkbox before sending.
      const consent = true;


      // NAME VALIDATION
      if (name.length < 2 || name.length > 100) {
        return res.status(400).json({ error: 'Please enter a valid name' });
      }

      // EMAIL VALIDATION
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
      }

      // RATING VALIDATION (0 = no rating, otherwise 1-5)
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }

      // MESSAGE VALIDATION
      if (message.length < 5 || message.length > 5000) {
        return res.status(400).json({
          error: 'Feedback must be between 5 and 5000 characters'
        });
      }


      // SAVE TO SUPABASE
      const { data, error } = await supabase
        .from('feedback')
        .insert({
          name,
          email: email || null,
          type: type || 'General',
          rating,
          message,
          consent
        })
        .select()
        .single();


      // DATABASE ERROR
      if (error) {
        console.error('Feedback save error:', error);
        return res.status(500).json({ error: 'Could not save feedback' });
      }


      // SUCCESS
      res.status(201).json({
        success: true,
        message: 'Thank you for your feedback!',
        feedback: data
      });

    } catch (err) {

      console.error('Feedback error:', err);

      res.status(500).json({ error: 'Could not submit feedback' });
    }
  }
);


// Public list of feedback (never returns email addresses)
app.get('/api/feedback', async (req, res) => {
  const { data, error } = await supabase
    .from('feedback')
    .select('name, rating, message, type, created_at')
    .eq('consent', true)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Feedback list error:', error);
    return res.status(500).json({ error: 'Could not load feedback' });
  }

  res.json(data || []);
});


// ============================================================
// SAVE PROJECT
// ============================================================

app.post(
  '/api/projects',
  requireUser,
  async (req, res) => {

    const { text, mood, typography, background, voice } = req.body;

    const userId = req.user.id;

    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id: userId,
        text,
        mood,
        typography,
        background,
        voice
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  }
);


// ============================================================
// LIST USER PROJECTS
// ============================================================

app.get(
  '/api/projects/:userId',
  requireUser,
  async (req, res) => {

    if (req.params.userId !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  }
);


// ============================================================
// DELETE PROJECT
// ============================================================

app.delete(
  '/api/projects/:id',
  requireUser,
  async (req, res) => {

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ deleted: true });
  }
);


// ============================================================
// START SERVER
// ============================================================

const port = process.env.PORT || 4000;

app.listen(port, () =>
  console.log(`Navaar backend running on port ${port}`)
);
