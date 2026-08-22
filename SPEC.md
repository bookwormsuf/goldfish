# Goldfish — Implementation Spec

A Telegram read-later bot on Supabase. Save links, get three to read each morning,
write your own notes, search them later.

**Status:** pinned. Written 2026-08-22 after two grilling sessions.

---

## Rules for the implementing agent

1. **Every decision in this document is pinned. Execute it verbatim.** Do not
   substitute a library, rename a column, restructure a table, or "improve" a query.
2. **If something is genuinely not specified here, stop and ask.** Do not guess and
   do not pick a reasonable default. An unspecified detail is a gap in the spec, and
   the fix is to fill the spec, not to improvise in code.
3. **Verification is not optional.** Each build step has acceptance checks. Run them
   and paste real output. Never claim a step is done without it.
4. **Never read, echo, or log secret values.** They flow from environment into the
   SDKs. The user sets them; you reference them by name only.
5. **Commit after each build step**, small and labelled.

---

## 1. Scope

**In scope (v1):** link capture, metadata fetch, LLM topic assignment, daily digest
of three, read/skip tracking, manual notes, topic browsing, full-text search, PDF
storage.

**Explicitly deferred:** note embeddings and vector search (step 9), second-brain
sync, full article text extraction, read-time estimation, backfill/import, inline
search mode, any web frontend, RLS policies, multi-user.

**Explicitly rejected:** AI-generated summaries of articles. Notes are the user's
own words only.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Database | Supabase Postgres, Singapore region |
| Compute | Supabase Edge Functions (Deno) |
| Scheduling | Supabase Cron (`pg_cron` + `pg_net`) |
| File storage | Supabase Storage, private bucket `papers` |
| Telegram client | Raw `fetch`. **No framework.** No grammY. |
| Topic assignment | Anthropic API, `claude-haiku-4-5-20251001`, raw `fetch` |
| Migrations | Supabase CLI, files in `supabase/migrations/` |

### Repo layout

```
goldfish/
  supabase/
    config.toml
    migrations/
      0001_init.sql
      0002_search.sql
      0003_cron.sql
    functions/
      telegram-webhook/index.ts
      daily-digest/index.ts
      _shared/
        telegram.ts        # Bot API wrappers
        db.ts              # Supabase client + queries
        metadata.ts        # URL normalisation + page metadata fetch
        topics.ts          # Haiku topic assignment
        copy.ts            # All user-facing strings
  test/
    fixtures/              # Sample Telegram update payloads
    smoke.sh
  .env.example
  README.md
  SPEC.md
  CLAUDE.md
```

### Environment

Set as Edge Function secrets. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically and must not be set manually.

| Name | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API auth |
| `TELEGRAM_SECRET_TOKEN` | Webhook header secret, any random 32+ char string |
| `ALLOWED_CHAT_ID` | The only chat the bot responds to |
| `ANTHROPIC_API_KEY` | Topic assignment |

---

## 3. Pinned decisions

### Architecture

**D1.** Telegram is called with raw `fetch`. Only these methods are implemented:
`sendMessage`, `sendDocument`, `answerCallbackQuery`, `editMessageReplyMarkup`,
`setMessageReaction`, `getFile`. No Bot API framework.

**D2.** The webhook returns `200 OK` immediately on receipt, before doing any work.
All processing happens inside `EdgeRuntime.waitUntil()`.

**D3.** Every incoming update's `update_id` is inserted into `processed_updates`
before processing. If the insert violates the primary key, the update is a
redelivery and is skipped silently.

**D4.** The webhook verifies the `X-Telegram-Bot-Api-Secret-Token` header against
`TELEGRAM_SECRET_TOKEN`. Mismatch returns `401` with no body.

**D5.** Any update whose chat ID is not `ALLOWED_CHAT_ID` returns `200`, is logged
via `console.log`, and produces no reply. Never tell an unknown chat the bot exists.

**D6.** Single-user. `user_id` exists on every table with a default of
`'00000000-0000-0000-0000-000000000001'`. No auth, no RLS policies in v1. Functions
use the service role key.

### Capture

**D7.** URL normalisation for `url_key`, in this exact order:
1. Lowercase the scheme and host. Leave the path case untouched.
2. Remove the fragment (`#...`).
3. Remove these query params only: `utm_source`, `utm_medium`, `utm_campaign`,
   `utm_term`, `utm_content`, `utm_id`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`,
   `igshid`, `ref`.
4. Keep every other query param, in their original order.
5. Remove a single trailing slash from the path, unless the path is exactly `/`.

Do not strip `www.`. Do not force HTTPS. Do not sort params. Conservative on purpose.

**D8.** Page metadata fetch:
- `AbortSignal.timeout(8000)`, `redirect: 'follow'`.
- Header `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`
- Read the response body as a stream, stop at 64KB, discard the rest.
- Extract by regex, first match wins, in this priority:
  - **Title:** `og:title` content → `<title>` inner text → the URL's hostname.
  - **Description:** `og:description` content → `<meta name="description">` content → `null`.
- Decode HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`) in
  both fields. Trim and collapse whitespace.
- Any failure (timeout, non-2xx, throw): set `fetch_ok = false`, `title` = the
  hostname, `description` = null, and **save the article anyway**.

**D9.** `domain` is the URL hostname with a leading `www.` removed, lowercased.
Used only for feed diversity.

**D10.** A message containing multiple URLs saves each one, in order, with one
confirmation message per article.

**D11.** Duplicate detection is on `(user_id, url_key)`. On a hit, the bot replies
with the original save date and does not insert. PDFs are never deduplicated.

### Topics

**D12.** Topics are assigned by `claude-haiku-4-5-20251001` at save time, from the
current contents of the `topics` table. Input is the title and description only.

**D13.** The model is forced into structured output with a tool definition. Do not
parse prose, do not ask for JSON in the prompt. Tool schema:

```json
{
  "name": "assign_topics",
  "description": "Assign 1-3 topics to an article.",
  "input_schema": {
    "type": "object",
    "properties": {
      "slugs": {
        "type": "array",
        "items": {"type": "string"},
        "minItems": 1,
        "maxItems": 3
      }
    },
    "required": ["slugs"]
  }
}
```

Call with `tool_choice: {"type": "tool", "name": "assign_topics"}`, `max_tokens: 200`.

**D14.** Any returned slug not present in the `topics` table is discarded. If nothing
survives, or the call fails for any reason, assign `other`. **Topic assignment must
never block or fail a save.**

**D15.** Topics added later via `/topic` are forward-only. Never re-tag existing
articles. No `/retag` command in v1.

**D16.** Seed topics, exactly these 15:

```
design-systems      Design Systems
research-methods    Research Methods
product-design      Product Design
civic-tech          Civic Tech
ai-tooling          AI Tooling
engineering         Engineering
career              Career
leadership          Leadership
writing             Writing
business-strategy   Business & Strategy
brand-visual        Brand & Visual
tools-software      Tools & Software
health-fitness      Health & Fitness
personal-finance    Personal Finance
other               Other
```

### Daily digest

**D17.** Runs at `0 0 * * *` UTC, which is 08:00 Asia/Singapore. `pg_cron` schedules
are UTC. Do not attempt timezone conversion in the schedule.

**D18.** Backoff: before sending, look at the two most recent `deliveries`. If every
`delivery_item` across both is still `status = 'unread'`, skip today entirely. Write
no delivery row. Send no message.

**D19.** Selection is weighted random favouring older articles, with one article per
domain, using Efraimidis-Spirakis weighted sampling:

```sql
with candidates as (
  select a.*,
         power(
           random(),
           1.0 / (1.0 + ln(1.0 + extract(epoch from (now() - a.saved_at)) / 86400.0))
         ) as score
  from articles a
  where a.user_id = $1
    and a.status = 'unread'
    and a.kind = 'link'
),
ranked as (
  select *,
         row_number() over (partition by coalesce(domain, '') order by score desc) as rn
  from candidates
)
select * from ranked where rn = 1 order by score desc limit 3;
```

Higher score wins. The `ln` compresses age so a one-year-old article is favoured but
a fresh one can still be picked. Do not replace this with `order by saved_at`.

*Added during Step 3 build*: this query needs a window function over a CTE,
which PostgREST (what `supabase-js` talks to) can't express — there's no way
to run it as a `.from(...)` chain. `SUPABASE_DB_URL` is auto-injected into
Edge Functions specifically for this case (confirmed against Supabase's own
docs), so `daily-digest` connects directly with the `jsr:@db/postgres` driver
and runs this SQL verbatim rather than wrapping it in a stored Postgres
function. Note: `id` comes back from that driver as a native `bigint`, which
neither `JSON.stringify` nor a `supabase-js` insert can serialize — cast it to
`Number` immediately after the query, before it touches anything else.

**D20.** Three separate messages, one per article. A header message
(`Morning. Three for you.`) is sent first. Each article message carries its own
inline keyboard and is recorded in `sent_messages` with `kind = 'article'`.

**D21.** If fewer than three unread links exist, send what there is and append the
short-pool line. If zero, send the empty line and write no delivery row.

*Interpretation used in Step 3*: "append" reads as its own trailing message
after the last article message, consistent with the header also being sent
as a separate message rather than folded into the first article's text.

**D22.** No liveness check on links at send time. Dead links are sent as-is.

### Interaction

**D23.** `callback_data` encodings, exactly:
- `r:<article_id>` — mark read
- `s:<article_id>` — mark skipped
- `t:<topic_id>:<offset>` — browse topic page

**D24.** On read/skip: update `status` and `resolved_at = now()`, call
`answerCallbackQuery` with text `Marked read` or `Marked skipped`, then
`editMessageReplyMarkup` to replace both buttons with a single non-actionable button
labelled `✓ Read` or `✗ Skipped` and `callback_data: "noop"`. A `noop` callback is
answered with an empty `answerCallbackQuery` and nothing else. **Never delete the
message.**

**D25.** `status` transitions are one-way. Once `read` or `skipped`, an article never
returns to the pool. Skipped articles are never resurfaced.

**D26.** A reply to a bot message is resolved via `sent_messages` on
`(chat_id, telegram_message_id)`:
- `kind = 'article'`, plain text → insert a note on that article, react ✍️ via
  `setMessageReaction`, send no reply message.
- `kind = 'article'`, text starting `/topic ` → create the topic if new, tag that
  article, reply with confirmation.
- `kind = 'topic_list'`, text is a bare integer → send that item as a full article
  message with buttons, recorded as a new `sent_messages` row with `kind='article'`.
- No matching row → ignore entirely.

**D27.** Notes are stored as plain markdown text, exactly as typed. No processing, no
summarising, no truncation.

### Search and browse

**D28.** `/search <query>` calls the `search_articles(q text)` Postgres function.
Ranking is `greatest(article_rank, note_rank * 1.5)` using `ts_rank`, top 5. Query
parsing uses `websearch_to_tsquery('english', q)`. Each result is sent as its own
article message with buttons, recorded in `sent_messages` with `kind='article'`.

**D29.** `/topics` sends one message whose inline keyboard has one button per topic,
labelled `<label> (<count>)`, counting all articles regardless of status. Two buttons
per row. Topics with zero articles are still shown.

**D30.** Tapping a topic button edits that same message into page 1 of the topic list.
Ordering: **unread before read/skipped, then `saved_at` descending within each group.**
10 per page. Titles are markdown links. Each line shows the status word. `◀ Prev` and
`Next ▶` buttons appear only when there is a page in that direction. The message is
recorded in `sent_messages` with `kind='topic_list'` and a `payload` of
`{"topic_id": n, "offset": n, "article_ids": [...]}` so a numeric reply can resolve.

### PDFs

**D31.** PDFs are stored in the private Supabase Storage bucket `papers` at
`papers/<article_id>.pdf`. Save order: insert the row with `storage_path = null`,
upload using the returned id, then update `storage_path`. A failed upload leaves
`storage_path` null and the bot reports the failure.

**D32.** Title is the message caption if present, otherwise the filename with a
trailing `.pdf` stripped. `description` is null. `fetch_ok` is true.

**D33.** Files over 20MB: reply with the size error and save nothing. Telegram bots
cannot download files above that limit.

**D34.** PDFs are excluded from the daily digest (`kind = 'link'` filter in D19).
They are searchable and browsable. No text extraction in v1.

### Housekeeping

**D35.** A weekly cron job deletes `processed_updates` rows older than 7 days.

**D36.** All user-facing strings live in `_shared/copy.ts`. No string literals in
handler code. See section 6.

### Additions (pinned during Step 1 build)

Step 1's implementation review surfaced two gaps the original spec left open.
Both were put to the user and settled — pinned here the same as D1-D36.

**D37.** URL extraction strips trailing punctuation from the match. After the
regex match, trim any of `.,;:!?)]}'"` off the end of the string, repeatedly,
before the URL is used for anything (hostname, storage, later normalisation).
This fixes cases like `https://x.com/post,` or `https://x.com/post).` from
ordinary sentence punctuation or markdown-link parens. Do not parse Telegram's
`message.entities` for this — extraction stays a plain regex match plus trim.

**D38.** If saving an article fails after its `update_id` has already been
inserted into `processed_updates` (D3), delete that `processed_updates` row
before returning from the background processing. This lets a genuine Telegram
redelivery, or the user resending the same link, retry the save instead of
being silently deduped away by a row that only exists because of a transient
failure.

---

## 4. Schema

### `0001_init.sql`

```sql
-- Topics: user-controlled, extendable via /topic
create table topics (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default '00000000-0000-0000-0000-000000000001',
  slug       text not null,
  label      text not null,
  created_at timestamptz not null default now(),
  unique (user_id, slug)
);

create table articles (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default '00000000-0000-0000-0000-000000000001',
  kind         text not null default 'link' check (kind in ('link', 'pdf')),
  url          text,
  url_key      text,
  domain       text,
  storage_path text,
  title        text,
  description  text,
  fetch_ok     boolean not null default true,
  status       text not null default 'unread'
                 check (status in ('unread', 'read', 'skipped')),
  saved_at     timestamptz not null default now(),
  resolved_at  timestamptz,

  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored,

  constraint articles_link_has_url check (kind <> 'link' or url is not null)
);

-- Partial: PDFs have a null url_key and must not collide
create unique index articles_user_url_key_uniq
  on articles (user_id, url_key) where url_key is not null;

create index articles_search_idx on articles using gin (search_vector);
create index articles_pool_idx on articles (user_id, status, kind, saved_at desc);

create table article_topics (
  article_id  bigint not null references articles(id) on delete cascade,
  topic_id    bigint not null references topics(id) on delete cascade,
  assigned_by text not null default 'llm' check (assigned_by in ('llm', 'user')),
  primary key (article_id, topic_id)
);

create index article_topics_topic_idx on article_topics (topic_id);

create table notes (
  id                  bigint generated always as identity primary key,
  article_id          bigint not null references articles(id) on delete cascade,
  body                text not null,
  telegram_message_id bigint,
  created_at          timestamptz not null default now(),

  search_vector tsvector generated always as (
    to_tsvector('english', body)
  ) stored
);

create index notes_article_idx on notes (article_id);
create index notes_search_idx on notes using gin (search_vector);

create table deliveries (
  id      bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  sent_on date not null,
  sent_at timestamptz not null default now(),
  unique (user_id, sent_on)
);

create table delivery_items (
  delivery_id bigint not null references deliveries(id) on delete cascade,
  article_id  bigint not null references articles(id) on delete cascade,
  position    smallint not null,
  primary key (delivery_id, article_id)
);

-- Maps every outbound bot message back to what it was about.
-- Buttons and replies both resolve through here.
create table sent_messages (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null default '00000000-0000-0000-0000-000000000001',
  chat_id             bigint not null,
  telegram_message_id bigint not null,
  kind                text not null check (kind in ('article', 'topic_list')),
  article_id          bigint references articles(id) on delete cascade,
  payload             jsonb,
  created_at          timestamptz not null default now(),
  unique (chat_id, telegram_message_id)
);

-- Idempotency guard (D3)
create table processed_updates (
  update_id   bigint primary key,
  received_at timestamptz not null default now()
);

insert into topics (slug, label) values
  ('design-systems',    'Design Systems'),
  ('research-methods',  'Research Methods'),
  ('product-design',    'Product Design'),
  ('civic-tech',        'Civic Tech'),
  ('ai-tooling',        'AI Tooling'),
  ('engineering',       'Engineering'),
  ('career',            'Career'),
  ('leadership',        'Leadership'),
  ('writing',           'Writing'),
  ('business-strategy', 'Business & Strategy'),
  ('brand-visual',      'Brand & Visual'),
  ('tools-software',    'Tools & Software'),
  ('health-fitness',    'Health & Fitness'),
  ('personal-finance',  'Personal Finance'),
  ('other',             'Other');

-- New tables are not auto-exposed to the API roles by default. D6 says
-- functions use the service role key with no RLS, so grant it direct access.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
```

*Added during Step 1 build*: the grant block above wasn't in the original pin.
Current Supabase projects don't auto-expose new tables to `service_role`
(`arwd` privileges are withheld by default now), so without it every query
from an Edge Function fails with Postgres error `42501`. This is a mechanical
consequence of D6 (service role, no RLS), not a new design decision.

The plain `grant ... on all tables` only covers tables that exist at the
moment it runs, so a Step 1 review caught that any table added by a later
migration would hit the same `42501` bug. The `alter default privileges`
statements make the grant standing for anything created afterward by the
`postgres` role (which is what migrations run as) — but not for a table
created by hand in the dashboard, which would need the explicit block
repeated.

### `0002_search.sql`

```sql
create or replace function search_articles(q text)
returns table (
  id          bigint,
  title       text,
  url         text,
  status      text,
  kind        text,
  rank        real
)
language sql
stable
as $$
  with tsq as (
    select websearch_to_tsquery('english', q) as query
  )
  select
    a.id,
    a.title,
    a.url,
    a.status,
    a.kind,
    greatest(
      ts_rank(a.search_vector, tsq.query),
      coalesce(
        (select max(ts_rank(n.search_vector, tsq.query)) * 1.5
         from notes n where n.article_id = a.id),
        0
      )
    )::real as rank
  from articles a, tsq
  where a.search_vector @@ tsq.query
     or exists (
       select 1 from notes n
       where n.article_id = a.id and n.search_vector @@ tsq.query
     )
  order by rank desc, a.saved_at desc
  limit 5;
$$;
```

### `0003_cron.sql`

Replace `<PROJECT_REF>` and the service role key reference at deploy time.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily digest, 08:00 Asia/Singapore = 00:00 UTC (D17)
select cron.schedule(
  'goldfish-daily-digest',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Housekeeping (D35)
select cron.schedule(
  'goldfish-prune-updates',
  '0 3 * * 0',
  $$ delete from processed_updates where received_at < now() - interval '7 days'; $$
);
```

---

## 5. Complete input table

Every message the bot can receive. No other behaviour exists.

| Input | Behaviour |
|---|---|
| Message with 1+ URLs | Save each in order. One confirmation per article. (D10) |
| Message with a PDF document | Save as `kind='pdf'`. (D31-D33) |
| Reply to an `article` message, plain text | Insert note. React ✍️. No reply message. (D26) |
| Reply to an `article` message, `/topic <name>` | Create topic if new, tag article, confirm. |
| Reply to a `topic_list` message, a bare number | Send that article as a full message with buttons. |
| `/search <query>` | Top 5, each as its own article message. (D28) |
| `/topics` | One message, topic buttons with counts. (D29) |
| `/stats` | Unread count, read count, saves in the last 7 days. |
| `/help` | The command list. |
| Plain text, no URL, not a reply | The nudge string. |
| Reply to a message not in `sent_messages` | Ignore entirely. |
| Any message from a chat ID ≠ `ALLOWED_CHAT_ID` | `200`, log, no reply. (D5) |
| Callback `r:` / `s:` | Mark read/skipped, edit keyboard. (D24) |
| Callback `t:` | Render topic page, edit message. (D30) |
| Callback `noop` | Empty `answerCallbackQuery`. Nothing else. |

---

## 6. Copy

All strings live in `_shared/copy.ts`. Terse, no exclamation marks, no emoji beyond
what is specified here. Do not invent additional strings; if a state needs copy that
is not listed, stop and ask.

```ts
export const copy = {
  saved: (title: string, topics: string) => `Saved · ${title}\n${topics}`,

  savedUnfetchable: (title: string) =>
    `Couldn't read that page, saved the link anyway.\n${title}\n(unfetchable)`,

  duplicate: (date: string) => `Already saved, ${date}.`,

  savedPdf: (title: string) => `Saved PDF · ${title}`,

  pdfTooBig: () => `Too big for Telegram, 20MB limit.`,

  pdfUploadFailed: (title: string) => `Saved ${title} but the file upload failed.`,

  digestHeader: () => `Morning. Three for you.`,

  digestShort: (n: number) => `That's all you've got — ${n} unread.`,

  digestEmpty: () => `Nothing unread. Send me some links.`,

  nudge: () => `Send me a link, or reply to an article to add a note.`,

  topicAdded: (label: string, title: string) => `Tagged ${title} · ${label}`,

  searchEmpty: (q: string) => `Nothing for "${q}".`,

  topicsHeader: () => `Topics`,

  topicListHeader: (label: string, count: number) =>
    `${label} · ${count} article${count === 1 ? '' : 's'}`,

  topicListFooter: () => `Reply with a number to open one.`,

  topicListEmpty: (label: string) => `Nothing in ${label} yet.`,

  stats: (unread: number, read: number, week: number) =>
    `${unread} unread · ${read} read · ${week} saved this week`,

  help: () =>
    `Send a link to save it.\n` +
    `Reply to an article to add a note.\n` +
    `Reply /topic <name> to tag it.\n\n` +
    `/search <query>\n/topics\n/stats`,

  markedRead: () => `Marked read`,
  markedSkipped: () => `Marked skipped`,
  btnRead: () => `Read`,
  btnSkip: () => `Skip`,
  btnDoneRead: () => `✓ Read`,
  btnDoneSkipped: () => `✗ Skipped`,
  btnPrev: () => `◀ Prev`,
  btnNext: () => `Next ▶`,
}
```

**Article message format** (digest, search results, opened-from-list) — one format,
used everywhere:

```
<b>{title}</b>
{description}

{topic labels, comma separated}
{url}
```

Parse mode `HTML`. Omit the description line entirely when null. Escape `&`, `<`,
`>` in all interpolated values.

---

## 7. Build order

Each step ends with a commit. Do not start a step before the previous step's checks
pass with pasted output.

### Step 1 — Skeleton and capture

`supabase init`, migration `0001_init.sql`, `telegram-webhook` function handling only:
secret header check, chat ID allowlist, `update_id` dedup, URL extraction, insert with
title from the hostname. No metadata fetch, no topics.

**Checks:** `supabase db reset` applies cleanly. `curl` with a fixture update payload
returns 200 and inserts a row. A second `curl` with the same `update_id` inserts
nothing. A `curl` with a wrong secret header returns 401. A `curl` with a foreign chat
ID returns 200 and inserts nothing.

### Step 2 — Metadata and dedup

`_shared/metadata.ts`: normalisation (D7), fetch and extract (D8), domain (D9).
Duplicate reply (D11). Multi-URL handling (D10).

**Checks:** save a real article URL and show the stored title, description, domain and
`url_key`. Save the same URL with `?utm_source=x` appended and show the duplicate
reply. Save a URL that 403s and show `fetch_ok = false` with the row still present.

### Step 3 — Daily digest, no buttons

`daily-digest` function. Selection query (D19), delivery rows, three messages, header,
short and empty cases (D21).

**Checks:** seed 10 articles across 4 domains with varied `saved_at`. Invoke the
function directly and paste the three chosen rows, showing no two share a domain. Run
it 20 times against the same seed data and show the selection varies while skewing
older.

### Step 4 — Buttons and backoff

Callback handling (D23, D24), `sent_messages` writes, one-way transitions (D25),
backoff rule (D18).

**Checks:** tap-equivalent `curl` marks read and edits the keyboard. Create two
deliveries with all items unread, invoke the digest, show it wrote nothing.

### Step 5 — Notes

Reply resolution through `sent_messages` (D26), note insert, ✍️ reaction (D27).

**Checks:** a reply payload targeting a known message inserts a note linked to the
right article. A reply targeting an unknown message inserts nothing and sends nothing.

### Step 6 — Topics

`_shared/topics.ts`, Haiku with forced tool output (D13), slug validation and `other`
fallback (D14), `/topic` command (D15).

**Checks:** save three articles on different subjects and paste the assigned topics.
Simulate an API failure (bad key) and show the article still saves with `other`.
Simulate a hallucinated slug and show it is discarded.

### Step 7 — Search and browse

`0002_search.sql`, `/search` (D28), `/topics` (D29), topic pages with pagination
(D30), numeric reply resolution.

**Checks:** search a word that appears only in a note and show the article returned.
Search a word only in a title and show it returned. Browse a topic with 12+ articles
and show page 2 works and ordering puts unread first.

### Step 8 — PDFs

Bucket creation, download, upload, insert-then-update (D31), title rules (D32), size
limit (D33), digest exclusion (D34).

**Checks:** upload a PDF and show the row plus the storage object. Show a PDF is
excluded from a digest run. Show a 25MB file is rejected without a row.

### Step 9 — Deploy and schedule

`0003_cron.sql`, `supabase db push`, `supabase functions deploy`, `setWebhook` with
the secret token.

**Checks:** paste the `setWebhook` response, `cron.job` contents, and one real saved
article end to end from the phone.

### Deferred to v2 (do not build)

Note embeddings with `gte-small`, `vector(384)` column, HNSW index, hybrid ranking.
Second-brain export. Inline search mode.

---

## 8. Open risk

Free-tier Supabase projects pause after a period of inactivity. A daily cron job
should count as activity, but this is unconfirmed. If the project pauses, the fix is
an external pinger or the paid tier. Check after the first two weeks of running.
