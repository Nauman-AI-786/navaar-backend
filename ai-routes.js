// Railway backend: add to your Express app -> app.use('/api/ai', require('./ai-routes'));
// Env vars on Railway: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
const express = require('express');
const router = express.Router();
const hits = new Map(); // simple per-user rate limit: 10 requests / hour

async function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_ANON_KEY }
  });
  return r.ok ? r.json() : null;
}

router.post('/poetry', async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    const now = Date.now(), list = (hits.get(user.id) || []).filter(t => now - t < 3600e3);
    if (list.length >= 10) return res.status(429).json({ error: 'Hourly AI limit reached. Try later.' });
    list.push(now); hits.set(user.id, list);

    const topic = String(req.body.topic || '').slice(0, 80);
    if (topic.length < 2) return res.status(400).json({ error: 'Topic required.' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5', max_tokens: 300,
        system: 'You write short original poetry for videos. Reply with ONLY 3 to 4 short lines, one per line, no title, no numbering, no quotes. Write in the same language and script as the topic (Urdu topic = Urdu script).',
        messages: [{ role: 'user', content: 'Topic: ' + topic }]
      })
    });
    const d = await r.json();
    const text = d.content && d.content[0] && d.content[0].text;
    if (!text) return res.status(502).json({ error: 'AI did not return text.' });
    res.json({ text: text.trim() });
  } catch (e) { res.status(500).json({ error: 'AI service error.' }); }
});

module.exports = router;
