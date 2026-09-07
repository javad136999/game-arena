# Game Arena

A Next.js 14 + Supabase starter for a multiplayer board/card game platform
(chess, poker, hokm, shelem, ludo, snakes & ladders, rock-paper-scissors)
with auth, a shared wallet, and post-game chat.

**What's actually working in this starter:** auth (sign up / log in), the
wallet and profile pages reading real data, and a complete, playable
**rock-paper-scissors** match end-to-end — matchmaking, realtime updates,
and server-side move resolution so no player can peek at the other's
choice. Every other game listed on the home page has its schema support
(`matches`, `match_players`, tables per game as needed) but no UI or
game-logic function yet — build them the same way `rps` was built (see
"Adding a new game" below).

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New project.
2. Once it's up, open **SQL Editor** and run the contents of
   [`supabase/schema.sql`](./supabase/schema.sql). This creates every
   table, row-level security policy, and the two RPC functions
   (`find_or_create_match`, `submit_move`) the RPS game uses.
3. In **Project settings → API**, copy the `Project URL` and
   `anon public` key.
4. In **Authentication → Providers**, email/password is enabled by
   default — that's all this starter uses.
5. In **Database → Replication**, confirm `matches` and `chat_messages`
   are enabled for realtime (the schema script does this for you via
   `alter publication supabase_realtime add table ...`, but it's worth
   checking in the dashboard).

## 2. Run it locally

```bash
cp .env.example .env.local
# paste your Project URL and anon key into .env.local
npm install
npm run dev
```

Open http://localhost:3000, sign up with an email/password, then open a
second browser (or incognito window) and sign up a second account to
test matchmaking in `Play RPS`.

## 3. GitHub

```bash
git init
git add .
git commit -m "Initial scaffold"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/game-arena.git
git push -u origin main
git checkout -b develop
git push -u origin develop
```

Work in `feature/*` branches off `develop`, open pull requests into
`develop`, and merge `develop` into `main` for production releases. The
included `.github/workflows/ci.yml` lints and builds on every PR — add
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` as
**repository secrets** (Settings → Secrets and variables → Actions) so
CI builds succeed.

## 4. Vercel

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new).
2. Framework preset: Next.js (auto-detected).
3. Add environment variables (Project Settings → Environment Variables):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - set these for **Production**, and add a second set pointed at a
     staging Supabase project for **Preview** deployments, matching the
     `.env.production` / `.env.staging` split from the original spec.
4. Every pull request automatically gets its own preview deployment;
   pushes to `main` deploy to production.

## 5. Payments — decision needed before wiring up deposits/cash-out

The wallet UI is in place but deposit/cash-out are stub buttons. As
discussed, this needs a decision before building further:

- **Payment gateway (fiat)** — standard path for Google Play, handles
  KYC/AML for you, works with bank cards.
- **Crypto wallet address** — you own KYC yourself, and Google Play
  restricts or disallows crypto payments specifically for real-money
  gambling.

Whichever you pick, check the licensing/geo-restriction requirement
flagged in the original spec **before** building the payment
integration — that's a legal question for a lawyer or regulatory
consultant, not a code question.

## 6. Adding a new game (the pattern `rps` follows)

1. Add a table for that game's per-round state if it needs one
   (`rps_moves` is the model — locked down with RLS so it's only
   reachable through a `SECURITY DEFINER` function, never read directly
   by the client).
2. Write a `submit_move`-style Postgres function that validates the
   move, checks whether the round/game is complete, and — only when it
   is — updates `matches.result` and settles the stake via `wallets` /
   `transactions`.
3. Build the page under `app/games/<slug>/page.tsx`, following
   `app/games/rps/page.tsx`: call `find_or_create_match`, subscribe to
   `postgres_changes` on the `matches` row, call your move function on
   each player action.
4. Flip `ready: true` for that game in `app/page.tsx`.

## 7. Still open from the original spec (not built here)

- Reconnect window / forfeit-on-disconnect logic
- Chess/poker/ludo/hokm/shelem/snakes-and-ladders game logic
- Tournament brackets
- Content moderation (profanity filter, report/block) on chat
- Account deletion flow (grace period + anonymization job)
- Play Store compliance docs (privacy policy, data safety form, etc.)
