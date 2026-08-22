-- D28, verbatim from SPEC.md.
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

-- Not in the original pin, same 42501 pattern as 0001_init.sql's grant
-- block: current Supabase projects don't auto-expose new functions to
-- service_role either. See SPEC.md's addendum after D28.
grant execute on function search_articles(text) to service_role;
