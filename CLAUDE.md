# CLAUDE.md

## What this is

Goldfish — a Telegram read-later bot on Supabase. Save links, get three to read each
morning, write your own notes, search them later.

## Read SPEC.md first. All of it.

`SPEC.md` is a **pinned implementation spec**, produced from two grilling sessions
with the user. Every decision in it was deliberated and settled.

1. **Execute it verbatim.** Do not substitute a library, rename a column,
   restructure a table, or improve a query. Deviations are bugs.
2. **If something is not specified, stop and ask.** Do not guess, do not pick a
   sensible default. A gap in the spec is fixed in the spec, not in code.
3. **Run the acceptance checks and paste real output.** No step is done without it.
   Never claim success you have not observed.
4. **Never read, echo, or log secret values.** Reference them by name only.
5. **Commit after each build step**, small and labelled.

## Build order

Section 7 of SPEC.md. Nine steps, each with checks. Do not start a step before the
previous step's checks pass.

## Things the user has already decided against

Do not propose these. They were considered and rejected:

- AI-generated summaries of articles. Notes are the user's own words only.
- Storing full article text.
- A web frontend. Supabase Table Editor is the admin UI.
- A Telegram bot framework. Raw `fetch` only.
- Backfilling from other read-later apps.
- Resurfacing skipped articles.
- Re-tagging existing articles when a new topic is added.

## Commands the user must run themselves

Interactive or secret-bearing. Ask, do not attempt:

```bash
supabase login
supabase link --project-ref <ref>
supabase secrets set <NAME>=<value>
```

## Local development

```bash
supabase start                        # requires Docker running
supabase db reset                     # apply all migrations
supabase functions serve <name>       # run a function locally
```

Test functions with `curl` against fixtures in `test/fixtures/`. There is no way to
drive a real Telegram client from here, so fixture payloads are the only verification
path for webhook behaviour.
