// Step 3 scope: selection query (D19), delivery rows, three messages, header,
// short and empty cases (D21). Step 4 adds: backoff (D18), per-article
// buttons and the `sent_messages` write (D20/D24).

import { DEFAULT_USER_ID, getServiceClient, withRawSql } from "../_shared/db.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { articleMessageHtml, copy } from "../_shared/copy.ts";

const ALLOWED_CHAT_ID = Deno.env.get("ALLOWED_CHAT_ID")!;

// D18: if every delivery_item across the two most recent deliveries is still
// unread, skip today entirely. Fewer than two deliveries on record means
// there's nothing to back off from yet.
export async function shouldBackOff(
  db: ReturnType<typeof getServiceClient>,
): Promise<boolean> {
  const { data: recent, error: deliveriesError } = await db
    .from("deliveries")
    .select("id")
    .eq("user_id", DEFAULT_USER_ID)
    .order("sent_at", { ascending: false })
    .limit(2);

  if (deliveriesError) {
    console.log("backoff: deliveries lookup failed", deliveriesError.code, deliveriesError.message);
    return false;
  }
  if (!recent || recent.length < 2) {
    return false;
  }

  const deliveryIds = recent.map((d) => d.id);
  const { data: items, error: itemsError } = await db
    .from("delivery_items")
    .select("articles(status)")
    .in("delivery_id", deliveryIds);

  if (itemsError) {
    console.log("backoff: delivery_items lookup failed", itemsError.code, itemsError.message);
    return false;
  }
  if (!items || items.length === 0) {
    return false;
  }

  return items.every((item) => {
    const article = item.articles as unknown as { status: string } | null;
    return article?.status === "unread";
  });
}

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

  if (await shouldBackOff(db)) {
    // D18: two ignored deliveries in a row. Write nothing, send nothing.
    return { sent: 0, backoff: true };
  }

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
    const sent = await sendMessage(ALLOWED_CHAT_ID, text, {
      parseMode: "HTML",
      replyMarkup: [[
        { text: copy.btnRead(), callback_data: `r:${article.id}` },
        { text: copy.btnSkip(), callback_data: `s:${article.id}` },
      ]],
    });

    if (sent.ok && sent.result) {
      // D20: every article message is recorded so buttons and replies (D26)
      // can resolve back to the article that produced it.
      const { error: sentMessageError } = await db.from("sent_messages").insert({
        user_id: DEFAULT_USER_ID,
        chat_id: Number(ALLOWED_CHAT_ID),
        telegram_message_id: sent.result.message_id,
        kind: "article",
        article_id: article.id,
      });
      if (sentMessageError) {
        console.log("sent_messages insert failed", sentMessageError.code, sentMessageError.message);
      }
    }
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
