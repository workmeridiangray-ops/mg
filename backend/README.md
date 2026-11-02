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
- `POST /api/book-call` — strategy-call booking. Required: `date` (YYYY-MM-DD),
  `time` (e.g. "10:00 AM"), `info.name`, `info.email`. Stores the booking, emails
  the team and the visitor, and — once Google Calendar is connected (see below) —
  creates a real calendar event with a Google Meet link and invites the visitor.
- `GET /api/availability?date=YYYY-MM-DD` — returns `{ available: [...] }`, the
  fixed slot list (`backend/src/index.js` → `SLOTS`) minus whatever's already busy
  on the connected Google Calendar. Falls back to showing every slot as open if
  the calendar isn't connected yet.
- `GET /api/health` — returns `{ok:true}` if the worker is live.

## Google Calendar integration (one-time setup)

Real availability and automatic event creation need a Google Calendar connected.
This uses a normal OAuth client (not a service account), authorized once by
whoever's calendar should be used:

1. In Google Cloud Console, create an OAuth 2.0 **Web application** client
   (APIs & Services → Credentials). Authorized redirect URI must be exactly:
   `https://meridiangray-backend.work-meridiangray.workers.dev/oauth/callback`
2. Add its `client_id` / `client_secret` as the `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` GitHub repo secrets (same place as `CLOUDFLARE_API_TOKEN`
   and `BREVO_API_KEY`) — the deploy workflow syncs them to the Worker automatically.
3. Visit `https://meridiangray-backend.work-meridiangray.workers.dev/oauth/start`
   in a browser, signed in as the Google account whose calendar should be used.
   Approve calendar access. You'll land on a "Calendar connected ✓" page.

That's it — the refresh token is stored in D1 (`app_settings` table) and reused
indefinitely; no further logins needed. If you ever need to reconnect (e.g. a
different calendar), just visit `/oauth/start` again.

## Zoho CRM integration (one-time setup)

Every Health Check submission is pushed into Zoho CRM as a Lead (standard
fields only — Name, Email, Phone, Company, Lead Source, and a Description
containing the full business details and every answer — so this works
without needing any custom fields set up in Zoho). Connected once, same
OAuth pattern as Google Calendar above:

1. In the [Zoho API Console](https://api-console.zoho.in/) (use `.com` or
   `.eu` instead of `.in` if your CRM is on a different data center — check
   the URL you use to log into Zoho CRM), create a **Server-based
   Application** client. Authorized redirect URI must be exactly:
   `https://meridiangray-backend.work-meridiangray.workers.dev/zoho/oauth/callback`
2. Add its `client_id` / `client_secret` as the `ZOHO_CLIENT_ID` /
   `ZOHO_CLIENT_SECRET` GitHub repo secrets (same place as the other secrets)
   — the deploy workflow syncs them to the Worker automatically.
3. If your CRM isn't on the `.in` data center, update `ZOHO_DC` in
   `wrangler.toml` (`"com"`, `"eu"`, etc.) and redeploy.
4. Visit `https://meridiangray-backend.work-meridiangray.workers.dev/zoho/oauth/start`
   in a browser, signed in as the Zoho CRM account leads should be created
   under. Approve access. You'll land on a "Zoho CRM connected ✓" page.

The refresh token is stored in D1 (`app_settings` table) and reused
indefinitely. A failed or not-yet-connected push never blocks the visitor's
submission or the team notification email — it's purely additive. Reconnect
any time (e.g. a different Zoho account) by visiting `/zoho/oauth/start` again.

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
