# Goldfish

A Telegram read-later bot on Supabase. Send it links, it sends three back every morning.

Named because I have the 7-second memory of a goldfish.

## Why this exists

I save so many articles everywhere but I hardly read them. I wanted to be able to put them in one place and handed to me like a little article butler.

I also thought it would be fun try out and experiment with telegram bots and databases, so why not.

## What it does

- **Capture.** Send a link. It saves the URL, title, meta description and domain. Claude Haiku assigns 1 to 3 tags from a fixed list stored in the database.
- **Daily digest.** At 08:00 SGT, three unread articles get sent out, one message each. Weighted random favouring older saves, never two from the same domain.
- **Backoff.** If the last two digests went untouched, skip the send entirely.
- **Read / Skip buttons.** One way. A skipped article never comes back.
- **Notes.** Reply to an article message and your reply is saved as a note. Your words only. The bot never writes summaries for you.
- **Search and browse.** `/search` covers titles, descriptions and your notes.
  `/topics` browses by tag.
- **PDFs.** Stored in a private bucket, re-sendable, excluded from the daily feed.

## How it fits together

| Layer           | Choice                               |
| --------------- | ------------------------------------ |
| Database        | Supabase Postgres                    |
| Compute         | Supabase Edge Functions (Deno)       |
| Scheduling      | Supabase Cron (`pg_cron` + `pg_net`) |
| File storage    | Supabase Storage, private bucket     |
| Telegram client | Raw `fetch`, no framework            |
| Tagging         | Anthropic API, Claude Haiku          |

Two functions. `telegram-webhook` handles every inbound update. `daily-digest` runs
once a day from cron. Everything shared lives in `supabase/functions/_shared/`.

## Read SPEC.md first

`SPEC.md` is the more useful half of this repo. It holds 38 pinned decisions written before any code, each with the reasoning that produced it, plus the complete schema,
the full input table and the build order.

A few of those decisions exist because writing them down caught a bug the design
already had:

- The first selection query used `distinct on (domain)`, which forces ordering by domain and quietly destroys the age weighting. Replaced with Efraimidis-Spirakis weighted sampling and a logarithmic age weight.
- Nothing in the original schema mapped an outbound Telegram message back to an article, which made both the buttons and reply-to-note unresolvable. Fixed with a `sent_messages` table.
- Telegram resends an update if your webhook is slow, so a slow save silently became a duplicate save. Fixed by acking `200` immediately and processing in `EdgeRuntime.waitUntil`, deduped on `update_id`.

## Running your own

This is written for one person: you. See [Single-user by design](#single-user-by-design)
before you start.

**You need** a Supabase project, a Telegram bot from [@BotFather](https://t.me/botfather), an Anthropic API key, Docker (for local development) and the Supabase CLI.

1. **Clone and link.**

   ```bash
   git clone https://github.com/bookwormsuf/goldfish.git
   cd goldfish
   supabase link --project-ref <your-project-ref>
   ```

2. **Set the digest URL.** `supabase/migrations/0003_cron.sql` contains a `<YOUR_PROJECT_REF>` placeholder in the cron job's target URL. Replace it with your own project ref before pushing. Hosted Supabase will not let you set a custom database GUC, so this one value has to be literal in the migration.

3. **Store the cron auth token in Vault.** In the dashboard, add a secret named `digest_cron_secret`. Any random 32+ character string. The cron job looks it up by name and sends it as a bearer token, and `daily-digest` checks the header itself.

4. **Push the schema.**

   ```bash
   supabase db push
   ```

5. **Set the function secrets.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
   injected for you and must not be set by hand.

   | Name                    | Purpose                                           |
   | ----------------------- | ------------------------------------------------- |
   | `TELEGRAM_BOT_TOKEN`    | Bot API auth, from BotFather                      |
   | `TELEGRAM_SECRET_TOKEN` | Webhook header secret, any random 32+ char string |
   | `ALLOWED_CHAT_ID`       | The only chat the bot will answer                 |
   | `ANTHROPIC_API_KEY`     | Tag assignment                                    |

   Copy `.env.example` to `.env.local` for local runs. `.env.local` is gitignored and must stay that way.

6. **Deploy and point Telegram at it.**

   ```bash
   supabase functions deploy
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<your-project-ref>.supabase.co/functions/v1/telegram-webhook" \
     -d "secret_token=<TELEGRAM_SECRET_TOKEN>"
   ```

7. **Send it a link.** Then check the `articles` table in the Supabase Table Editor, which is the entire admin UI.

The cron schedule is UTC, so the `0 0 * * *` in `0003_cron.sql` is 08:00 Singapore.
Change it for your own timezone.

## Making it yours

- **Tags** are seeded at the bottom of `0001_init.sql` and read live from the database, so the LLM can only ever pick from that list. Edit the seed before your first push, or edit the table afterwards. Mine are design and engineering heavy; yours will not be.
- **Every user-facing string** lives in `supabase/functions/_shared/copy.ts`.
- **Digest size, weighting and backoff** are in `daily-digest/index.ts`, with the reasoning for each in SPEC.md.

## Single-user by design

There is one bot token, one allowed chat ID, one cron row, and no row-level security.
Edge Functions talk to Postgres with the service role key.

That is a deliberate v1 decision. `user_id` columns are present on every table from the first migration, so RLS policies can slot in later without a
schema migration. But making this genuinely multi-tenant means real auth, policies on every table, per-user bot registration and per-user scheduling.

**Deploy it for yourself, not for other people.** If you point it at a shared Supabase project or hand the bot to a second person, the isolation you are assuming is not there.

## Deliberately not here

- **No AI summaries.** The bot never writes about an article for you. Haiku only picks
  tags from a list you control. The notes are the point, and they have to be yours.
- **No full article text.** Search runs over titles, descriptions and your notes. This is also what keeps a free local embedding model viable for a future v2, since its ~512-token limit is fine for short notes and useless for whole articles.
- **No frontend.** The Supabase Table Editor is a perfectly good admin panel for one person.
- **No backfill.** It starts empty on purpose. Import 800 stale links and your morning three come from 2023.

Deferred to a possible v2: note embeddings and vector search, second-brain export,
inline search mode.

## Status

Built, deployed and running daily. It is a personal project shared as a reference, not a maintained product. Issues and pull requests may not get a reply.

## Licence

MIT. See [LICENSE](LICENSE).
