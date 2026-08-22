import { createClient } from "npm:@supabase/supabase-js@2";

// D6: single-user, no auth. Matches the default on every table in 0001_init.sql.
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, key);
}
