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
    const d = await r.json().catch(() => ({}));
if (!r.ok || d.error) {
  console.error('Gemini error', r.status, JSON.stringify(d).slice(0, 500));
  const msg = (d.error && d.error.message) ? String(d.error.message).slice(0, 160) : 'code ' + r.status;
  return res.status(502).json({ error: 'AI error: ' + msg });
}
const parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
const text = parts.map(p => p.text || '').join('').trim();
if (!text) {
  console.error('Gemini empty', JSON.stringify(d).slice(0, 500));
  return res.status(502).json({ error: 'AI did not return text.' });
}
    res.json({ text: text.trim() });
  } catch (e) { res.status(500).json({ error: 'AI service error.' }); }
});

// ---- Photo -> Cartoon (Cloudflare Workers AI FLUX.2 klein, free daily allowance) ----
const cartoonHits = new Map(); // 5 cartoons / hour / user
const STYLES = {
  cartoon: { t: 'classic 2D cartoon illustration with bold clean outlines, flat vibrant colors and simple cel shading' },
  anime: { t: 'anime illustration with clean line art, soft cel shading, large expressive eyes and vibrant colors' },
  pixar: { t: '3D animated movie character with smooth skin, big expressive eyes and soft studio lighting' },
  chibi: { t: 'cute chibi character with an oversized head, tiny body, big sparkling eyes and pastel colors' },
  comic: { t: 'comic book illustration with thick black ink outlines, halftone dots, dramatic shading and bold colors' },
  manga: { t: 'black and white manga panel with detailed ink line art, screentone shading and dramatic contrast' },
  sketch: { t: 'detailed pencil sketch portrait with clean line art and light hatching shading, black and white' },
  charcoal: { t: 'expressive charcoal drawing on textured paper with smudged soft shadows and strong contrast' },
  watercolor: { t: 'soft watercolor painting with flowing washes of color, visible paper texture and gentle edges' },
  oil: { t: 'rich oil painting with visible brush strokes, warm colors and realistic lighting' },
  popart: { t: 'pop art poster in bold flat colors, thick outlines and halftone dots, high contrast' },
  pixel: { t: '16-bit pixel art with a limited color palette and crisp square pixels' },
  clay: { t: 'claymation stop-motion character made of soft plasticine clay with fingerprints texture and warm lighting' },
  paper: { t: 'layered paper cut-out craft artwork with soft shadows between the layers and matte colors' },
  neon: { t: 'neon cyberpunk illustration with glowing pink and blue rim lights and a dark background' },
  vector: { t: 'modern flat vector illustration with simple geometric shapes and a clean limited color palette' },
  lowpoly: { t: 'low-poly 3D render made of flat triangular facets with soft gradient colors' },
  glass: { t: 'stained glass artwork with bold black lead lines and glowing translucent colored panes' },
  caricature: { t: 'fun caricature with exaggerated head proportions and playful expressive features while staying recognizable' },
  crayon: { t: 'colorful crayon drawing on paper with waxy strokes and a playful hand-drawn look' },
  retro80s: { t: 'an authentic vintage 1980s color film photograph of the same person standing on a busy city street with old cars and shop signs, wearing a period-correct 1980s tweed suit with a paisley tie, warm faded film colors, film grain, light scratches and dust, slightly worn aged print', scene: true },
  retro70s: { t: 'a 1970s color photograph of the same person in a groovy disco setting with warm orange tones, wide-collar shirt, film grain and soft focus', scene: true },
  retro50s: { t: 'a black and white 1950s studio portrait photograph of the same person in period clothing, soft studio lighting, film grain and slight age damage', scene: true },
  victorian: { t: 'a Victorian-era sepia studio portrait of the same person in formal 19th century clothing, antique photograph with soft focus and worn edges', scene: true },
  renaissance: { t: 'a Renaissance oil painting portrait of the same person in rich period clothing with dramatic chiaroscuro lighting and a dark background', scene: true },
  mughal: { t: 'a Mughal miniature painting portrait of the same person as a royal figure in ornate traditional court clothing and jewelry, fine detail, gold accents and a decorated border', scene: true },
  superhero: { t: 'a comic book superhero in a dynamic heroic pose with a stylish cape and suit, dramatic city skyline behind, bold colors', scene: true },
  astronaut: { t: 'an astronaut in a realistic space suit with the helmet visor open, with Earth and stars behind', scene: true },
  knight: { t: 'a medieval knight in detailed shining armor standing in a castle courtyard, cinematic lighting', scene: true },
  cowboy: { t: 'a Wild West cowboy with a hat and leather vest standing in a dusty desert town at golden hour, cinematic film look', scene: true },
  cyberpunk: { t: 'a cyberpunk character in a rainy neon-lit futuristic city at night with glowing signs and reflections, cinematic', scene: true },
  wizard: { t: 'a fantasy wizard in an embroidered robe holding a glowing staff in a magical forest, painterly cinematic lighting', scene: true },
  winter: { t: 'the same person in warm winter clothes standing in a beautiful snowy landscape with falling snow, soft cinematic light', scene: true },
  beach: { t: 'the same person relaxing on a beautiful beach at golden sunset with warm light and gentle waves', scene: true }
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
    const style = Object.prototype.hasOwnProperty.call(STYLES, req.body.style) ? STYLES[req.body.style] : STYLES.cartoon;

    list.push(now); cartoonHits.set(user.id, list);

    // FLUX.2 klein 4B on Workers AI: image editing, takes multipart form data
    const url = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID +
      '/ai/run/@cf/black-forest-labs/flux-2-klein-4b';
    const form = new FormData();
    const prompt = style.scene
      ? 'Redraw image 0 as ' + style.t + '. Keep the exact same face, facial features, expression, hairstyle, beard and skin tone so the person stays clearly recognizable. No text overlays, no watermark.'
      : 'Redraw image 0 as a ' + style.t + '. Keep the exact same face shape, facial features, expression, hairstyle, skin tone, clothing, pose and background composition as in image 0. The person must stay clearly recognizable. No text, no watermark, no extra people.';
    form.append('prompt', prompt);
    form.append('input_image_0', new Blob([Buffer.from(img, 'base64')], { type: 'image/jpeg' }), 'photo.jpg');

    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.CF_API_TOKEN }, // fetch sets the multipart boundary itself
      body: form
    });
    const raw = await r.text().catch(() => '');
    if (!r.ok) {
      cartoonHits.set(user.id, list.slice(0, -1)); // failed, don't count it
      console.error('Cloudflare cartoon error', r.status, raw.slice(0, 400)); // see Railway Logs
      let hint = 'Cartoon service error (code ' + r.status + ').';
      try { const j = JSON.parse(raw); if (j.errors && j.errors[0]) hint += ' ' + String(j.errors[0].message).slice(0, 160); } catch (e) {}
      return res.status(r.status === 429 ? 429 : 502).json({ error: hint });
    }
    let b64 = '';
    try { const j = JSON.parse(raw); b64 = (j.result && j.result.image) || j.image || ''; } catch (e) {}
    if (!b64) {
      cartoonHits.set(user.id, list.slice(0, -1));
      console.error('Cloudflare cartoon: no image in response', raw.slice(0, 300));
      return res.status(502).json({ error: 'Cartoon service returned no image.' });
    }
    res.json({ image: 'data:image/jpeg;base64,' + b64 });
  } catch (e) { res.status(500).json({ error: 'Cartoon service error.' }); }
});

module.exports = router;
