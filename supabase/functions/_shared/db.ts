import { createClient } from "npm:@supabase/supabase-js@2";

// D6: single-user, no auth. Matches the default on every table in 0001_init.sql.
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

// D6: "the service role key" — Supabase's new key system replaces the
// legacy JWT SUPABASE_SERVICE_ROLE_KEY with SUPABASE_SECRET_KEYS, a JSON
// dictionary of named secret keys, auto-injected the same as the legacy var
// was. Full-access, bypasses RLS, same as D6 intends. See SPEC.md's
// addendum after D6.
export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !secretKeysRaw) {
    throw new Error("SUPABASE_URL or SUPABASE_SECRET_KEYS not set");
  }
  const key = JSON.parse(secretKeysRaw).default;
  if (!key) {
    throw new Error("SUPABASE_SECRET_KEYS has no 'default' entry");
  }
  return createClient(url, key);
}
