# Meridian Gray — Website Backend

A Cloudflare Worker handling the three things your static site currently can't:
contact/project-brief submissions, System Finder health-check submissions, and
newsletter signups — each one stored in D1 and triggering an email notification
via Brevo.

The D1 database (`meridiangray-db`) is already created and linked in `wrangler.toml`
with 3 tables: `contact_submissions`, `health_check_submissions`, `newsletter_subscribers`.

## Deploy (5 minutes)

You need Node.js installed. Then, from this folder:

```bash
npm install -g wrangler        # one-time, if you don't have it
wrangler login                 # opens a browser, log into your Cloudflare account
npx wrangler deploy            # deploys the worker
```

That prints a URL like `https://meridiangray-backend.<your-subdomain>.workers.dev`.
That's your live backend.

### Set your Brevo API key (so email notifications actually send)

```bash
npx wrangler secret put BREVO_API_KEY
```

Paste your Brevo API key when prompted (Brevo dashboard → SMTP & API → API Keys).
Without this, forms still save to the database, they just won't email you.

### Point it at your real domain (optional, recommended)

Once deployed, in the Cloudflare dashboard → Workers & Pages → meridiangray-backend →
Settings → Triggers, add a custom route like `api.meridiangray.in/*` (requires
`meridiangray.in` to be on Cloudflare DNS). Then update `ALLOWED_ORIGIN` in
`wrangler.toml` to `https://www.meridiangray.in` (already set) and redeploy.

## Endpoints

- `POST /api/contact` — project brief / contact form. Required: `name`, `email`, `main_problem`.
- `POST /api/health-check` — System Finder submission, fired automatically once a
  visitor reaches their diagnosis. Required: `sector`, `business_type`. Also accepts
  `custom_label` (when they typed their own business), `info` (the full business-details
  form: name, email, phone, cc, biz, role, web, year, city, region, branches, team,
  turnover), `answers` (every question id → chosen option index/indices, raw), and
  `scores` (the frontend's own computed `{ overall, research, design, develop, automate,
  market }`, each 0-100 — the frontend owns the scoring logic per sector, the backend
  just stores what it's given).
- `POST /api/newsletter` — newsletter signup. Required: `email`.
- `GET /api/health` — returns `{ok:true}` if the worker is live.

## Health-check data

Every submission is stored in full: the flattened business-details columns (for
easy browsing in the D1 dashboard), plus `answers_json` and `info_json` holding the
complete raw objects, so nothing is lost even as the question set evolves.

## Viewing submissions

Query D1 directly:

```bash
npx wrangler d1 execute meridiangray-db --remote --command "SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT 20"
npx wrangler d1 execute meridiangray-db --remote --command "SELECT * FROM health_check_submissions ORDER BY created_at DESC LIMIT 20"
```

Or connect D1 to a dashboard later (Cloudflare's own D1 browser in the dashboard
works immediately, no extra setup).
