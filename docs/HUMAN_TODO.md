# HUMAN TODO — actions only Will can take

Running list. Items are appended by phase; nothing is deleted, only checked off.
⏰ = start early, long lead time.

## Phase 0

- [ ] **Create the Supabase project** (supabase.com → New project, region close to first users).
      Then copy into `.env` (never commit): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
      `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (Settings → API → JWT Secret), and
      `DATABASE_URL` (Settings → Database → connection string, use the `postgresql+psycopg://`
      prefix). Apply migrations: `cd apps/api && uv run alembic upgrade head`.
      For mobile, set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
      in `apps/mobile/.env`.
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
