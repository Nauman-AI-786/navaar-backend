// Railway backend: add to your Express app -> app.use('/api/ai', require('./ai-routes'));
// Env vars on Railway: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, CF_ACCOUNT_ID, CF_API_TOKEN
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

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You write short original poetry for videos. Reply with ONLY 3 to 4 short lines, one per line, no title, no numbering, no quotes. Write in the same language and script as the topic (Urdu topic = Urdu script).' }] },
        contents: [{ role: 'user', parts: [{ text: 'Topic: ' + topic }] }],
        generationConfig: { maxOutputTokens: 300 }
      })
    });
    const d = await r.json();
    const text = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0].text;
    if (!text) return res.status(502).json({ error: 'AI did not return text.' });
    res.json({ text: text.trim() });
  } catch (e) { res.status(500).json({ error: 'AI service error.' }); }
});

// ---- Photo -> Cartoon (Cloudflare Workers AI, free daily allowance) ----
const cartoonHits = new Map(); // 5 cartoons / hour / user
const STYLES = {
  cartoon: 'cartoon illustration, bold outlines, flat vibrant colors, clean shading',
  anime: 'anime style portrait, soft cel shading, big expressive eyes, vibrant colors',
  pixar: '3d pixar style cartoon character, smooth skin, soft lighting, colorful',
  sketch: 'pencil sketch drawing, detailed line art, black and white'
};

router.post('/cartoon', express.json({ limit: '6mb' }), async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!process.env.CF_ACCOUNT_ID || !process.env.CF_API_TOKEN)
      return res.status(503).json({ error: 'Cartoon service is not connected yet.' });

    const now = Date.now(), list = (cartoonHits.get(user.id) || []).filter(t => now - t < 3600e3);
    if (list.length >= 5) return res.status(429).json({ error: 'Hourly cartoon limit reached. Try later.' });

    let img = String(req.body.image || '').replace(/^data:image\/\w+;base64,/, '');
    if (img.length < 100 || img.length > 5.5e6) return res.status(400).json({ error: 'Send a smaller photo.' });
    const style = STYLES[req.body.style] || STYLES.cartoon;

    list.push(now); cartoonHits.set(user.id, list);

    const url = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID +
      '/ai/run/@cf/runwayml/stable-diffusion-v1-5-img2img';
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.CF_API_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: style + ', same person, same pose',
        negative_prompt: 'blurry, deformed, extra fingers, text, watermark',
        image_b64: img,
        strength: 0.6,
        guidance: 7.5,
        num_steps: 20
      })
    });
    if (!r.ok) {
      cartoonHits.set(user.id, list.slice(0, -1)); // failed, don't count it
      return res.status(r.status === 429 ? 429 : 502).json({ error: 'Cartoon service is busy. Try again later.' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.json({ image: 'data:image/png;base64,' + buf.toString('base64') });
  } catch (e) { res.status(500).json({ error: 'Cartoon service error.' }); }
});

module.exports = router;
