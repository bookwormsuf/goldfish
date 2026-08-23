-- D31: private Storage bucket for PDFs. Not a table in section 4's schema,
-- but the same "infra as a migration" pattern as everything else here — see
-- SPEC.md's addendum after D34.
insert into storage.buckets (id, name, public)
values ('papers', 'papers', false)
on conflict (id) do nothing;
