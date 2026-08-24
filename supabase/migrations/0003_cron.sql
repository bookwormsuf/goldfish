create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily digest, 08:00 Asia/Singapore = 00:00 UTC (D17).
--
-- Hosted Supabase Postgres doesn't grant permission to set an arbitrary
-- custom GUC (ALTER DATABASE ... SET app.service_role_key fails with
-- 42501), so the auth token this job sends is stored in Supabase Vault
-- instead and looked up by name. See SPEC.md's addendum after D17 for
-- the full account (also why daily-digest now checks this header itself —
-- verify_jwt = false means Supabase's own gateway never did).
--
-- SETUP: replace <YOUR_PROJECT_REF> below with your own Supabase project ref
-- before running `supabase db push`. The same GUC restriction above means this
-- one value has to be a literal here rather than a setting.
select cron.schedule(
  'goldfish-daily-digest',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'digest_cron_secret'
      )
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
