require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
app.use(cors());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PRICE_IDS = {
  creator_monthly: process.env.STRIPE_PRICE_CREATOR_MONTHLY,
  creator_annual: process.env.STRIPE_PRICE_CREATOR_ANNUAL,
  studio_monthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY,
  studio_annual: process.env.STRIPE_PRICE_STUDIO_ANNUAL,
};

// --- Stripe webhook needs the raw body, so it's registered BEFORE express.json() ---
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const plan = session.metadata?.plan || 'creator';

      await supabase.from('subscriptions').upsert({
        user_id: userId,
        plan,
        status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        updated_at: new Date().toISOString(),
      });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', sub.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Create a Stripe Checkout session for a given plan
// body: { plan: 'creator'|'studio', billing: 'monthly'|'annual', userId: string }
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, billing, userId } = req.body;
    const key = `${plan}_${billing}`;
    const priceId = PRICE_IDS[key];
    if (!priceId) return res.status(400).json({ error: 'Unknown plan or billing cycle' });
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      metadata: { plan },
      success_url: process.env.CLIENT_SUCCESS_URL,
      cancel_url: process.env.CLIENT_CANCEL_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// Get the caller's current plan/status
app.get('/api/subscription/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.params.userId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { plan: 'free', status: 'inactive' });
});

// Save a project (poetry/lyrics + style choices)
app.post('/api/projects', async (req, res) => {
  const { userId, text, mood, typography, background, voice } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId and text are required' });

  const { data, error } = await supabase
    .from('projects')
    .insert({ user_id: userId, text, mood, typography, background, voice })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// List a user's saved projects
app.get('/api/projects/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete a saved project
app.delete('/api/projects/:id', async (req, res) => {
  const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Navaar backend running on port ${port}`));
