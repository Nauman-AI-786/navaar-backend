# Navaar Studio — Backend

A small Express backend for the Navaar Studio site: saved projects synced to a real database, and LemonSqueezy checkout for the Creator/Studio plans.

## Stack
- **Supabase** — Postgres database + user auth (email/password)
- **LemonSqueezy** — subscription checkout and billing (test mode and live mode are separate)
- **Railway** — hosts this Express server

## 1. Set up Supabase
1. Create a project at supabase.com.
2. Go to **SQL Editor** and run everything in `schema.sql`.
3. Go to **Project Settings > API** and copy the project `URL` and the `service_role` key into your environment variables. Keep the `service_role` key secret: it belongs only on the server, never in `index.html`.
4. Enable **Authentication > Providers > Email**. Before launch, turn **Confirm email** back on and connect a custom SMTP provider (for example Resend) under **Authentication > SMTP Settings**, so confirmation emails reach real users.
5. In `index.html`, only the project URL and the publishable (anon) key are used.

> Note: the `subscriptions` table columns are still named `stripe_customer_id` and `stripe_subscription_id` from an earlier version. They now store the LemonSqueezy customer ID and subscription ID. No change is needed.

## 2. Set up LemonSqueezy
1. Create a store at lemonsqueezy.com. Use **test mode** while building.
2. Create two products, **Creator** and **Studio**, each with a monthly and an annual subscription variant (4 variants in total).
3. Under **Settings > API**, create an API key.
4. Under **Settings > Webhooks**, add an endpoint at `https://your-backend-url/api/webhook` with a signing secret. Enable the subscription events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`.
5. Copy the values into the environment variables below.
6. Test mode uses LemonSqueezy's test card details. No real charges are made.

### Going live
Test and live data are separate in LemonSqueezy. After your store is approved, repeat steps 2–4 in live mode (products and 4 variants, new API key, new webhook with the same URL and a new secret), then replace the Railway variables with the live values.

## 3. Environment variables
| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (secret) |
| `LEMONSQUEEZY_API_KEY` | LemonSqueezy API key |
| `LEMONSQUEEZY_STORE_ID` | Your LemonSqueezy store ID |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | Signing secret of the webhook |
| `LEMONSQUEEZY_VARIANT_CREATOR_MONTHLY` | Variant ID |
| `LEMONSQUEEZY_VARIANT_CREATOR_ANNUAL` | Variant ID |
| `LEMONSQUEEZY_VARIANT_STUDIO_MONTHLY` | Variant ID |
| `LEMONSQUEEZY_VARIANT_STUDIO_ANNUAL` | Variant ID |
| `CLIENT_SUCCESS_URL` | Page users return to after paying |
| `PORT` | Set automatically by Railway (defaults to 4000 locally) |

## 4. Run locally
```bash
npm install
npm start
```
Create a `.env` file with the variables above. The server runs at `http://localhost:4000`.

## 5. Deploy on Railway
1. Push this folder to a GitHub repo.
2. On railway.app, create a **New Project > Deploy from GitHub repo** and pick the repo.
3. Railway detects Node and runs `npm install` and `npm start`.
4. Add all variables from the table above in the service's **Variables** tab.
5. Under **Settings > Networking**, generate a public domain and use it as `BACKEND_URL` in `index.html` and as the webhook URL host in LemonSqueezy.

## API endpoints
Routes marked "login" need the signed-in user's token in an `Authorization: Bearer <token>` header. The server reads the user from that token, never from the request body.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Health check |
| POST | `/api/checkout` | login | Creates a LemonSqueezy checkout for `{ plan, billing }` and returns its `url` |
| POST | `/api/webhook` | signature | LemonSqueezy calls this; the `X-Signature` header is verified with the webhook secret |
| GET | `/api/subscription/:userId` | login | Current plan and status |
| POST | `/api/projects` | login | Save a poetry/lyrics project |
| GET | `/api/projects/:userId` | login | List a user's saved projects |
| DELETE | `/api/projects/:id` | login | Delete a saved project |

## How index.html uses this
- **Sign in / Sign up:** Supabase Auth in the browser. Sign up collects name, profile details and preferred plan (stored as user metadata).
- **Saved projects:** synced through `/api/projects` when signed in; saved in the browser's `localStorage` for guests.
- **Choose Creator / Choose Studio:** calls `/api/checkout` and redirects to the returned LemonSqueezy checkout `url`.
