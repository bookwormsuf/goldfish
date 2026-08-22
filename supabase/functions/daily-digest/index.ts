// Step 3 scope: selection query (D19), delivery rows, three messages, header,
// short and empty cases (D21). No buttons yet (step 4), no backoff yet
// (step 4, D18) — this function always selects and sends what's available.

import { DEFAULT_USER_ID, getServiceClient, withRawSql } from "../_shared/db.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { articleMessageHtml, copy } from "../_shared/copy.ts";

const ALLOWED_CHAT_ID = Deno.env.get("ALLOWED_CHAT_ID")!;

// D19, verbatim from SPEC.md. Do not replace with `order by saved_at`.
const SELECTION_QUERY = `
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
`;

interface SelectedArticle {
  id: number;
  title: string;
  description: string | null;
  url: string;
  domain: string | null;
}

export async function selectDigestArticles(): Promise<SelectedArticle[]> {
  return await withRawSql(async (client) => {
    const result = await client.queryObject<SelectedArticle>(
      SELECTION_QUERY,
      [DEFAULT_USER_ID],
    );
    // deno-postgres maps bigint columns (article id) to native BigInt.
    // Downstream code (JSON, supabase-js inserts) can't serialize BigInt.
    return result.rows.map((row) => ({ ...row, id: Number(row.id) }));
  });
}

async function runDigest() {
  const db = getServiceClient();
  const selected = await selectDigestArticles();

  if (selected.length === 0) {
    // D21: zero unread, send the empty line, write no delivery row.
    await sendMessage(ALLOWED_CHAT_ID, copy.digestEmpty());
    return { sent: 0 };
  }

  // D20: header message first.
  await sendMessage(ALLOWED_CHAT_ID, copy.digestHeader());

  for (const article of selected) {
    // Topic assignment lands in step 6; topics is empty until then.
    const text = articleMessageHtml({
      title: article.title,
      description: article.description,
      topics: "",
      url: article.url,
    });
    await sendMessage(ALLOWED_CHAT_ID, text, { parseMode: "HTML" });
  }

  if (selected.length < 3) {
    // D21: short pool, append the short-pool line as its own message.
    await sendMessage(ALLOWED_CHAT_ID, copy.digestShort(selected.length));
  }

  const sentOn = new Date().toISOString().slice(0, 10);
  const { data: delivery, error: deliveryError } = await db
    .from("deliveries")
    .insert({ user_id: DEFAULT_USER_ID, sent_on: sentOn })
    .select("id")
    .single();

  if (deliveryError) {
    console.log("delivery insert failed", deliveryError.code, deliveryError.message);
    return { sent: selected.length, deliveryWritten: false };
  }

  const items = selected.map((article, index) => ({
    delivery_id: delivery.id,
    article_id: article.id,
    position: index + 1,
  }));
  const { error: itemsError } = await db.from("delivery_items").insert(items);
  if (itemsError) {
    console.log("delivery_items insert failed", itemsError.code, itemsError.message);
  }

  return { sent: selected.length, deliveryWritten: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const result = await runDigest();
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
