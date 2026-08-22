// Step 3 scope: selection query (D19), delivery rows, three messages, header,
// short and empty cases (D21). Step 4 adds: backoff (D18), per-article
// buttons and the `sent_messages` write (D20/D24).

import { DEFAULT_USER_ID, getServiceClient } from "../_shared/db.ts";
import { sendMessage } from "../_shared/telegram.ts";
import { sendArticleMessage } from "../_shared/browse.ts";
import { copy } from "../_shared/copy.ts";

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

// D19's query (verbatim in supabase/migrations/0001_init.sql's
// select_digest_candidates function — a window function over a CTE, which
// PostgREST can't express inline). Called via .rpc() rather than a direct
// Postgres connection now that search_articles (Step 7) established that
// pattern for this exact problem.
export async function selectDigestArticles(
  db: ReturnType<typeof getServiceClient>,
): Promise<Array<{ id: number }>> {
  const { data, error } = await db.rpc("select_digest_candidates", {
    target_user_id: DEFAULT_USER_ID,
  });
  if (error) {
    console.log("select_digest_candidates rpc failed", error.code, error.message);
    return [];
  }
  return (data ?? []) as Array<{ id: number }>;
}

async function runDigest() {
  const db = getServiceClient();

  if (await shouldBackOff(db)) {
    // D18: two ignored deliveries in a row. Write nothing, send nothing.
    return { sent: 0, backoff: true };
  }

  const selected = await selectDigestArticles(db);

  if (selected.length === 0) {
    // D21: zero unread, send the empty line, write no delivery row.
    await sendMessage(ALLOWED_CHAT_ID, copy.digestEmpty());
    return { sent: 0 };
  }

  // D20: header message first.
  await sendMessage(ALLOWED_CHAT_ID, copy.digestHeader());

  // Same "send full article message with buttons, record sent_messages"
  // helper used by search results and topic-list reopening (Step 7) — one
  // implementation of the article-message format instead of a second copy
  // that can (and did) drift out of sync with it.
  for (const article of selected) {
    await sendArticleMessage(db, ALLOWED_CHAT_ID, article.id);
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
