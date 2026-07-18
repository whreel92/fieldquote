# HUMAN TODO — actions only Will can take

Running list. Items are appended by phase; nothing is deleted, only checked off.
⏰ = start early, long lead time.

## Phase 0

- [x] **Create the Supabase project** — done 2026-07-18 (project `qamhpzoxojpduqiktbpf`; keys in
      `.env`, `SUPABASE_URL` corrected from placeholder, `apps/mobile/.env` written; token
      verification confirmed live via JWKS/ES256).
- [ ] **DATABASE_URL still points at localhost.** Grab the hosted connection string:
      Supabase dashboard → your project → Connect (top bar) → "Session pooler" URI, substitute
      your database password, and put it in `.env` as
      `DATABASE_URL=postgresql+psycopg://postgres.qamhpzoxojpduqiktbpf:<PASSWORD>@<pooler-host>:5432/postgres`
      (keep the `postgresql+psycopg://` prefix). If you've lost the DB password: Settings →
      Database → Reset database password. Then apply the schema:
      `cd apps/api && uv run alembic upgrade head`.
- [ ] **Enable GitHub Actions** on github.com/whreel92/fieldquote (Settings → Actions → General →
      Allow all actions) — the Actions tab currently says workflows are disabled, so CI can't run.
      Claude can click this for you with your say-so.
- [ ] **Anthropic API key** (console.anthropic.com) → `ANTHROPIC_API_KEY`. Needed Phase 3.
- [ ] **Deepgram API key** (console.deepgram.com, free tier fine to start) → `DEEPGRAM_API_KEY`.
      Needed Phase 3.
- [ ] **Stripe account** (dashboard.stripe.com) — activate test mode now; live activation needs
      business details. Create a **Connect platform application** (Settings → Connect) and copy
      `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID`. Webhook secret comes when we register the
      endpoint (Phase 6). Needed Phase 6.
- [ ] ⏰ **Twilio account + A2P 10DLC registration** — REGISTER THE BRAND AND CAMPAIGN NOW; carrier
      vetting takes 2–6 weeks. twilio.com → Messaging → Regulatory compliance → A2P 10DLC.
      You'll need business EIN, website, sample messages ("Your proposal from {company} is ready:
      {link}"). Copy `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and create a Messaging Service →
      `TWILIO_MESSAGING_SERVICE_SID`. SMS features stay behind a flag until approved.
- [ ] **Resend account** (resend.com) + verify the sending domain → `RESEND_API_KEY`. Needed
      Phase 6 (proposal emails); nice to have earlier for auth emails via Supabase SMTP.
- [ ] ⏰ **Apple Developer Program** ($99/yr, D-U-N-S if LLC — can take days) and **Google Play
      Console** ($25 one-time). Needed for EAS builds by Phase 4 device testing, submission
      Phase 11.
- [ ] **RevenueCat project** (app.revenuecat.com, free tier) → `REVENUECAT_API_KEY`. Needed
      Phase 10.
- [ ] **Sentry org + 3 projects** (api/mobile/web) → the three `SENTRY_DSN_*` vars. Optional until
      staging.
- [ ] **PostHog project** → `POSTHOG_KEY`. Optional until staging.

## Standing (from Phase 2 onward)

- [ ] **Recruit 2–3 licensed electrician advisors** to validate the assembly catalog
      (`docs/ASSEMBLY_VALIDATION.md` will be the packet). **No production launch until advisors
      flip assemblies to `advisor_approved`. Placeholder prices must never reach a real
      customer.**
- [ ] **Attorney review** of `docs/LEGAL_COPY.md` (estimate disclaimer, ToS, e-sign consent)
      before any real customer signs anything.
