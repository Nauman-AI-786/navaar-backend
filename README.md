# Navaar Studio — Backend (free-tier stack)

A minimal backend for the Navaar Studio site: saved projects synced to a real database, and Stripe Checkout for the Creator/Studio plans. Built to run entirely on free tiers.

## Stack
- **Supabase** (free tier) — Postgres database + user auth
- **Stripe** (free account, test mode is free) — subscription checkout + billing
- **Render** (free web service) — hosts this Express server

## 1. Set up Supabase (free)
1. Create a project at supabase.com (free tier).
2. Go to **SQL Editor** and run everything in `schema.sql`.
3. Go to **Project Settings > API** and copy the `URL` and `service_role` key into your `.env`.
4. Enable **Authentication > Providers > Email** (or any provider) so users can sign in — the frontend needs a `userId` to save projects or start checkout.

## 2. Set up Stripe (free to create, test mode is free)
1. Create a Stripe account.
2. In **Products**, create "Creator" and "Studio" products, each with a monthly and annual price. Copy the four price IDs into `.env`.
3. In **Developers > Webhooks**, add an endpoint pointing to `https://your-backend-url/api/webhook`, listening for `checkout.session.completed` and `customer.subscription.deleted`. Copy the signing secret into `.env`.
4. Use Stripe's test card `4242 4242 4242 4242` for free end-to-end testing — no real charges.

## 3. Run locally
```bash
cp .env.example .env   # fill in your keys
npm install
npm start
```
Server runs at `http://localhost:4000`.

## 4. Deploy for free (Render)
1. Push this folder to a GitHub repo.
2. On render.com, create a **New Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add all the same variables from `.env` in Render's **Environment** tab.
5. Free tier sleeps after inactivity — the first request after idle time takes a few seconds to wake up.

## API endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/checkout` | Creates a Stripe Checkout session for a plan |
| POST | `/api/webhook` | Stripe calls this to confirm payment |
| GET | `/api/subscription/:userId` | Current plan/status for a user |
| POST | `/api/projects` | Save a poetry/lyrics project |
| GET | `/api/projects/:userId` | List a user's saved projects |
| DELETE | `/api/projects/:id` | Delete a saved project |

## Connecting this to the existing index.html
Right now the website saves projects in the browser's `localStorage` and the pricing buttons don't call anything. To connect them:
- Add Supabase Auth (email/password or magic link) to `index.html` so each visitor has a `userId`.
- Replace the `localStorage` calls in the Saved projects panel with `fetch` calls to `/api/projects`.
- Make the "Choose Creator" / "Choose Studio" buttons `fetch('/api/checkout', { method:'POST', body: JSON.stringify({ plan, billing, userId }) })` and redirect the browser to the returned `url`.

Ask if you'd like these two changes wired directly into `index.html` next.
