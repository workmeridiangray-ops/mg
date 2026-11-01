# Deployment — GitHub → Cloudflare

This repo has two deployable parts. One is already fully automatic, the other
needs a one-time 2-minute click that can't be done through an API (it's a
GitHub App OAuth install — Cloudflare requires a human to click "Authorize").

## 1. The website itself (static pages) → Cloudflare Pages

**One-time setup (you, ~2 minutes):**

1. Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git**.
2. Pick `workmeridiangray-ops/mg`, authorize the Cloudflare GitHub App when prompted.
3. Build settings: **Framework preset: None**, **Build command: (leave blank)**,
   **Build output directory: /** (repo root — the HTML files are already static).
4. Deploy.

**After that:** every push to `main` auto-deploys the whole site — no further
action, ever. Point your domain (`www.meridiangray.in`) at the Pages project
under its Custom Domains tab (also one-time).

## 2. The backend (Cloudflare Worker) → already automatic

Workers deploy via a GitHub Action already committed here
(`.github/workflows/deploy-backend.yml`) — needs one secret added once:

1. Get a Cloudflare API token (dashboard → My Profile → API Tokens → Create
   Token → "Edit Cloudflare Workers" template).
2. GitHub repo → Settings → Secrets and variables → Actions → New repository
   secret → `CLOUDFLARE_API_TOKEN` → paste it.
3. (Optional) add `BREVO_API_KEY` the same way, so form-submission emails send.

After that, every push touching `backend/` deploys itself. Full detail in
`backend/README.md`.

## Then: wire the frontend to the live backend

Once the Worker is deployed, you get a URL back — either
`https://meridiangray-backend.<your-subdomain>.workers.dev` or, if you set up
a custom route (`api.meridiangray.in`, see `backend/README.md`), that domain.

Six lines across the site say `const ENQUIRY_ENDPOINT=''` (`index.html`,
`about.html`, `services.html`, `where-you-stand.html`, `what-weve-done.html`,
`where-to-find-us.html`) and one in `what-we-think.html` says
`const NEWSLETTER_ENDPOINT=''`. Fill in the deployed URL + `/api/contact` or
`/api/newsletter` in each, commit, push — Pages redeploys automatically and
the forms go live.
