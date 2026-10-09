# Connect cloud sync (one time, ~10 minutes)

The app works fully offline without this. Do these steps only when you want
both iPhones to share one household.

## 1. Create the free project

1. Go to supabase.com → Sign up / Sign in.
2. **New project** → name `family-meals`, pick a region near you, set a database
   password (store it in a password manager — you almost never need it again).
3. Wait until the project is green/active.

> If you ignore the project for a week, Supabase pauses it (free-plan rule).
> If the app suddenly says "not reachable", open the Supabase dashboard →
> **Resume project**. Your data is kept.

## 2. Create the tables

1. In Supabase: **SQL Editor → New query**.
2. Open `supabase/schema.sql` in this repo, copy the whole file, paste, **Run**.
3. It should report success with no red errors.

## 3. (Recommended) Fix the email limit

Supabase's built-in email sender allows ~2 auth emails/hour. For a 2-person
household that is usually fine, but password resets can get stuck. Optional:
**Authentication → Emails → SMTP Settings** → add your own sender
(e.g. a free Resend or Gmail SMTP). Skip this if sign-up emails arrive fine.

## 4. Connect the app

1. In Supabase: **Project Settings → API**. Copy:
   - **Project URL** (`https://....supabase.co`)
   - **anon public key** (the long one under "anon public" — NEVER the
     `service_role` secret key; the app must never see it).
2. In `app/`, copy `.env.example` to `.env` and paste the two values:
   - `VITE_SUPABASE_URL=...`
   - `VITE_SUPABASE_ANON_KEY=...`
3. Restart the dev server (`npm run dev`). Open **More → Household**:
   it should now offer Sign up / Sign in instead of "not connected".

`.env` is git-ignored — keys stay on your machine and never ship in commits.

## 5. Link the two iPhones

1. On phone A: sign up, create household ("Our Home"), **create invite**,
   copy the code (shown once).
2. On phone B: sign in, **join with code**, paste it.
3. Both phones: open the app (foreground) to sync. Sync also runs when the
   connection returns after being offline.

## What sync does and does not do

- Syncs on app open, foreground return, reconnect, and manual Retry.
- No background sync while closed (iOS limitation) — open the app to sync.
- Same-field edits on both phones produce a conflict card: you pick
  Keep mine / Keep theirs. Nothing is silently overwritten.
- Monthly JSON export (More → Data) remains your safety net.
