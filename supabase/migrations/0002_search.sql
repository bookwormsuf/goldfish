-- D28: /search calls this with one argument. Single-user v1 (D6) — the
-- default user id is hardcoded here rather than taken as a parameter,
-- mirroring DEFAULT_USER_ID in supabase/functions/_shared/db.ts.
create or replace function search_articles(q text)
returns table (
  id          bigint,
  title       text,
  description text,
  url         text,
  domain      text,
  rank        real
)
language sql
stable
as $$
  with parsed as (
    select websearch_to_tsquery('english', q) as tsq
  ),
  article_hits as (
    select a.id, ts_rank(a.search_vector, parsed.tsq) as article_rank
    from articles a, parsed
    where a.user_id = '00000000-0000-0000-0000-000000000001'
      and a.search_vector @@ parsed.tsq
  ),
  note_hits as (
    select n.article_id, max(ts_rank(n.search_vector, parsed.tsq)) as note_rank
    from notes n, parsed
    where n.search_vector @@ parsed.tsq
    group by n.article_id
  )
  select
    a.id,
    a.title,
    a.description,
    a.url,
    a.domain,
    greatest(coalesce(ah.article_rank, 0), coalesce(nh.note_rank, 0) * 1.5) as rank
  from articles a
  left join article_hits ah on ah.id = a.id
  left join note_hits nh on nh.article_id = a.id
  where ah.id is not null or nh.article_id is not null
  order by rank desc
  limit 5;
$$;

grant execute on function search_articles(text) to service_role;
