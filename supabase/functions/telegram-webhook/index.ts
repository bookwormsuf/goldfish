import { DEFAULT_USER_ID, getServiceClient } from "../_shared/db.ts";
import { domainOf, fetchMetadata, normalizeUrlKey } from "../_shared/metadata.ts";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
  setMessageReaction,
} from "../_shared/telegram.ts";
import { assignTopics, findOrCreateTopic } from "../_shared/topics.ts";
import { copy } from "../_shared/copy.ts";

const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const ALLOWED_CHAT_ID = Deno.env.get("ALLOWED_CHAT_ID");

const URL_REGEX = /https?:\/\/[^\s<>"]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  // D37: strip trailing punctuation picked up from sentences or markdown links.
  return matches.map((url) => url.replace(TRAILING_PUNCTUATION, ""));
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

async function saveLink(db: ReturnType<typeof getServiceClient>, chatId: string, url: string) {
  const urlKey = normalizeUrlKey(url);
  const domain = domainOf(url);

  // D11: duplicate check happens before insert, on (user_id, url_key).
  const { data: existing, error: lookupError } = await db
    .from("articles")
    .select("saved_at")
    .eq("user_id", DEFAULT_USER_ID)
    .eq("url_key", urlKey)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.log("duplicate lookup failed", lookupError.code, lookupError.message);
    return false;
  }

  if (existing) {
    await sendMessage(chatId, copy.duplicate(formatDate(existing.saved_at as string)));
    return true;
  }

  const meta = await fetchMetadata(url);

  const { data: inserted, error: insertError } = await db
    .from("articles")
    .insert({
      kind: "link",
      url,
      url_key: urlKey,
      domain,
      title: meta.title,
      description: meta.description,
      fetch_ok: meta.fetchOk,
    })
    .select("id")
    .single();

  if (insertError) {
    console.log("article insert failed", insertError.code, insertError.message);
    return false;
  }

  // D12: assignment runs regardless of fetch_ok — a bare-hostname title with
  // no description just tends to land on `other` (D14's fallback), it isn't
  // excluded outright.
  const topics = await assignTopics(db, meta.title, meta.description);
  if (topics.length > 0) {
    const { error: tagError } = await db.from("article_topics").insert(
      topics.map((t) => ({ article_id: inserted.id, topic_id: t.id, assigned_by: "llm" })),
    );
    if (tagError) {
      console.log("article_topics insert failed", tagError.code, tagError.message);
    }
  }
  const topicLabels = topics.map((t) => t.label).join(", ");

  if (meta.fetchOk) {
    await sendMessage(chatId, copy.saved(meta.title, topicLabels));
  } else {
    await sendMessage(chatId, copy.savedUnfetchable(meta.title));
  }
  return true;
}

// D23: callback_data encodings. `t:<topic_id>:<offset>` (topic browsing)
// lands in step 7 once topics exist; any prefix besides r/s/noop is logged
// and otherwise ignored for now.
async function processCallbackQuery(
  db: ReturnType<typeof getServiceClient>,
  callbackQuery: Record<string, unknown>,
) {
  const callbackQueryId = callbackQuery.id as string;
  const data = callbackQuery.data as string | undefined;
  const cbMessage = callbackQuery.message as Record<string, unknown> | undefined;
  const chat = cbMessage?.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id !== undefined ? String(chat.id) : undefined;
  const messageId = cbMessage?.message_id as number | undefined;

  if (!data || chatId !== ALLOWED_CHAT_ID || messageId === undefined) {
    console.log("rejected callback_query", chatId, data);
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  if (data === "noop") {
    // D24: the replaced, non-actionable button. Empty ack, nothing else.
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  const match = data.match(/^([rs]):(\d+)$/);
  if (!match) {
    console.log("unrecognised callback_data", data);
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  const [, action, articleIdStr] = match;
  const articleId = Number(articleIdStr);
  const newStatus = action === "r" ? "read" : "skipped";

  // D25: one-way transition. The `.eq("status", "unread")` guard means a
  // retried callback (or a stale keyboard tapped twice) can't flip it back
  // or re-resolve an already-resolved article.
  const { data: updated, error: updateError } = await db
    .from("articles")
    .update({ status: newStatus, resolved_at: new Date().toISOString() })
    .eq("id", articleId)
    .eq("status", "unread")
    .select("id");

  if (updateError) {
    console.log("article status update failed", updateError.code, updateError.message);
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  const ackText = action === "r" ? copy.markedRead() : copy.markedSkipped();
  await answerCallbackQuery(callbackQueryId, ackText);

  // D24: replace both buttons with a single non-actionable one. Runs even
  // if this callback lost the race (article already resolved), so a stale
  // keyboard on screen still gets cleaned up. Never delete the message.
  const doneLabel = action === "r" ? copy.btnDoneRead() : copy.btnDoneSkipped();
  await editMessageReplyMarkup(chatId, messageId, [[
    { text: doneLabel, callback_data: "noop" },
  ]]);

  if (!updated || updated.length === 0) {
    console.log("callback_query on already-resolved article", articleId);
  }
}

// D26's `/topic ` branch: create the topic if new (D15, forward-only —
// never re-tags older articles), tag this one article, confirm.
async function tagArticleWithTopic(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  articleId: number,
  articleTitle: string,
  rawName: string,
) {
  if (!rawName.trim()) {
    return;
  }

  const topic = await findOrCreateTopic(db, rawName);
  if (!topic) {
    return;
  }

  const { error: tagError } = await db
    .from("article_topics")
    .upsert(
      { article_id: articleId, topic_id: topic.id, assigned_by: "user" },
      { onConflict: "article_id,topic_id" },
    );
  if (tagError) {
    console.log("article_topics insert failed", tagError.code, tagError.message);
    return;
  }

  await sendMessage(chatId, copy.topicAdded(topic.label, articleTitle));
}

// D26: resolves a reply to a bot message via `sent_messages` on
// (chat_id, telegram_message_id). `topic_list` numeric resolution needs
// browsing to exist at all (Step 7), so that branch stays a no-op here.
async function handleReply(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  repliedToMessageId: number,
  replyMessageId: number,
  text: string,
) {
  const { data: sentMessage, error } = await db
    .from("sent_messages")
    .select("kind, article_id, articles(title)")
    .eq("chat_id", Number(chatId))
    .eq("telegram_message_id", repliedToMessageId)
    .maybeSingle();

  if (error) {
    console.log("sent_messages lookup failed", error.code, error.message);
    return;
  }
  if (!sentMessage || sentMessage.kind !== "article") {
    // D26: no matching row, or a topic_list message (Step 7). Ignore entirely.
    return;
  }

  if (text.startsWith("/topic ")) {
    const articleTitle = (sentMessage.articles as unknown as { title: string }).title;
    await tagArticleWithTopic(
      db,
      chatId,
      sentMessage.article_id,
      articleTitle,
      text.slice("/topic ".length),
    );
    return;
  }

  const { error: noteError } = await db.from("notes").insert({
    article_id: sentMessage.article_id,
    body: text,
    telegram_message_id: replyMessageId,
  });

  if (noteError) {
    console.log("note insert failed", noteError.code, noteError.message);
    return;
  }

  // D27: react, send no reply message.
  await setMessageReaction(chatId, replyMessageId, "✍️");
}

async function processUpdate(update: Record<string, unknown>) {
  const db = getServiceClient();

  const updateId = update.update_id;
  const { error: dedupError } = await db
    .from("processed_updates")
    .insert({ update_id: updateId });

  if (dedupError) {
    if (dedupError.code === "23505") {
      // Redelivery of an update we already processed. Skip silently. (D3)
      return;
    }
    console.log("processed_updates insert failed", dedupError.code);
    return;
  }

  const callbackQuery = update.callback_query as Record<string, unknown> | undefined;
  if (callbackQuery) {
    await processCallbackQuery(db, callbackQuery);
    return;
  }

  const message = update.message as Record<string, unknown> | undefined;
  if (!message) {
    return;
  }

  const chat = message.chat as Record<string, unknown> | undefined;
  const chatId = chat?.id !== undefined ? String(chat.id) : undefined;
  if (chatId !== ALLOWED_CHAT_ID) {
    console.log("rejected update from foreign chat", chatId);
    return;
  }

  const text = message.text as string | undefined;
  if (!text) {
    return;
  }

  const replyTo = message.reply_to_message as Record<string, unknown> | undefined;
  if (replyTo) {
    const repliedToMessageId = replyTo.message_id as number;
    const replyMessageId = message.message_id as number;
    await handleReply(db, chatId, repliedToMessageId, replyMessageId, text);
    return;
  }

  const urls = extractUrls(text);
  let hadFailure = false;
  for (const url of urls) {
    const ok = await saveLink(db, chatId, url);
    if (!ok) {
      hadFailure = true;
    }
  }

  if (hadFailure) {
    // D38: don't let a transient failure get permanently deduped away.
    // Deleting the processed_updates row lets a genuine redelivery retry.
    await db.from("processed_updates").delete().eq("update_id", updateId);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== TELEGRAM_SECRET_TOKEN) {
    return new Response(null, { status: 401 });
  }

  const update = await req.json();

  // @ts-ignore -- EdgeRuntime is a global provided by the Supabase Edge Functions runtime.
  EdgeRuntime.waitUntil(processUpdate(update));

  return new Response("ok", { status: 200 });
});
