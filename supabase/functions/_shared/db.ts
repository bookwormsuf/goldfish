import { createClient } from "npm:@supabase/supabase-js@2";
import { Client } from "jsr:@db/postgres@0.19.5";

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

// D19's selection query needs a window function over a CTE, which PostgREST
// (the REST layer supabase-js talks to) can't express. SUPABASE_DB_URL is
// auto-injected by the Edge Functions runtime for exactly this case: a
// direct Postgres connection for raw SQL, per Supabase's own docs.
export async function withRawSql<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    throw new Error("SUPABASE_DB_URL not set");
  }
  const client = new Client(dbUrl);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
