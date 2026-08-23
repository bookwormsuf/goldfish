import { DEFAULT_USER_ID, getServiceClient } from "../_shared/db.ts";
import { domainOf, fetchMetadata, normalizeUrlKey } from "../_shared/metadata.ts";
import {
  answerCallbackQuery,
  downloadFile,
  editMessageReplyMarkup,
  editMessageText,
  getFile,
  sendMessage,
  setMessageReaction,
} from "../_shared/telegram.ts";
import { assignTags, findOrCreateTag } from "../_shared/tags.ts";
import { fetchTagMenu, fetchTagPage, renderTagListMessage, sendArticleMessage } from "../_shared/browse.ts";
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
  const tags = await assignTags(db, meta.title, meta.description);
  if (tags.length > 0) {
    const { error: tagError } = await db.from("article_tags").insert(
      tags.map((t) => ({ article_id: inserted.id, tag_id: t.id, assigned_by: "llm" })),
    );
    if (tagError) {
      console.log("article_tags insert failed", tagError.code, tagError.message);
    }
  }
  const tagLabels = tags.map((t) => t.label).join(", ");

  if (meta.fetchOk) {
    await sendMessage(chatId, copy.saved(meta.title, tagLabels));
  } else {
    await sendMessage(chatId, copy.savedUnfetchable(meta.title));
  }
  return true;
}

const PDF_MAX_BYTES = 20 * 1024 * 1024;

// D32: filename with a trailing .pdf stripped.
function pdfTitleFromFilename(filename: string): string {
  return filename.replace(/\.pdf$/i, "");
}

// D31-D33: insert-then-upload-then-update, size limit enforced before ever
// calling getFile, and PDFs are never deduplicated (D11). Returns false only
// when the article row itself couldn't be created — a download/upload
// failure is D31's own prescribed graceful outcome (row stays, storage_path
// null, bot reports it), not the kind of failure D38's retry-via-redelivery
// covers.
async function savePdf(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  document: Record<string, unknown>,
  caption: string | undefined,
): Promise<boolean> {
  const fileId = document.file_id as string;
  const fileName = (document.file_name as string | undefined) ?? "document.pdf";
  const fileSize = document.file_size as number | undefined;

  if (fileSize !== undefined && fileSize > PDF_MAX_BYTES) {
    await sendMessage(chatId, copy.pdfTooBig());
    return true;
  }

  const title = caption?.trim() ? caption.trim() : pdfTitleFromFilename(fileName);

  const { data: inserted, error: insertError } = await db
    .from("articles")
    .insert({ kind: "pdf", title, description: null, fetch_ok: true })
    .select("id")
    .single();

  if (insertError) {
    console.log("pdf article insert failed", insertError.code, insertError.message);
    return false;
  }

  // D12: assignment runs the same as a link save, title + null description.
  const tags = await assignTags(db, title, null);
  if (tags.length > 0) {
    const { error: tagError } = await db.from("article_tags").insert(
      tags.map((t) => ({ article_id: inserted.id, tag_id: t.id, assigned_by: "llm" })),
    );
    if (tagError) {
      console.log("article_tags insert failed", tagError.code, tagError.message);
    }
  }

  const fileInfo = await getFile(fileId);
  const filePath = fileInfo.result?.file_path;
  const bytes = filePath ? await downloadFile(filePath) : null;

  if (!bytes) {
    await sendMessage(chatId, copy.pdfUploadFailed(title));
    return true;
  }

  const { error: uploadError } = await db.storage
    .from("papers")
    .upload(`${inserted.id}.pdf`, bytes, { contentType: "application/pdf" });

  if (uploadError) {
    console.log("pdf upload failed", uploadError.message);
    await sendMessage(chatId, copy.pdfUploadFailed(title));
    return true;
  }

  // D31: storage_path is the full papers/<id>.pdf location, updated only
  // after a successful upload.
  const { error: updateError } = await db
    .from("articles")
    .update({ storage_path: `papers/${inserted.id}.pdf` })
    .eq("id", inserted.id);
  if (updateError) {
    console.log("pdf storage_path update failed", updateError.code, updateError.message);
  }

  await sendMessage(chatId, copy.savedPdf(title));
  return true;
}

// D30: tapping a tag button (or Prev/Next) edits the same message into
// the requested page and (re)records it in sent_messages with the new
// payload, so a later numeric reply always resolves against what's on
// screen right now.
async function handleTagPageCallback(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  messageId: number,
  tagId: number,
  offset: number,
  callbackQueryId: string,
) {
  const page = await fetchTagPage(db, tagId, offset);
  if (!page) {
    await answerCallbackQuery(callbackQueryId);
    return;
  }

  const { text, keyboard } = renderTagListMessage(tagId, offset, page);
  await editMessageText(chatId, messageId, text, { parseMode: "Markdown", replyMarkup: keyboard });
  await answerCallbackQuery(callbackQueryId);

  const articleIds = page.items.map((i) => i.id);
  const { error } = await db.from("sent_messages").upsert(
    {
      user_id: DEFAULT_USER_ID,
      chat_id: Number(chatId),
      telegram_message_id: messageId,
      kind: "tag_list",
      payload: { tag_id: tagId, offset, article_ids: articleIds },
    },
    { onConflict: "chat_id,telegram_message_id" },
  );
  if (error) {
    console.log("sent_messages upsert failed", error.code, error.message);
  }
}

// D23: callback_data encodings.
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

  const tagMatch = data.match(/^t:(\d+):(\d+)$/);
  if (tagMatch) {
    const [, tagIdStr, offsetStr] = tagMatch;
    await handleTagPageCallback(db, chatId, messageId, Number(tagIdStr), Number(offsetStr), callbackQueryId);
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

// D26's `/tag ` branch: create the tag if new (D15, forward-only —
// never re-tags older articles), tag this one article, confirm.
async function applyTagToArticle(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  articleId: number,
  articleTitle: string,
  rawName: string,
) {
  if (!rawName.trim()) {
    return;
  }

  const tag = await findOrCreateTag(db, rawName);
  if (!tag) {
    return;
  }

  const { error: tagError } = await db
    .from("article_tags")
    .upsert(
      { article_id: articleId, tag_id: tag.id, assigned_by: "user" },
      { onConflict: "article_id,tag_id" },
    );
  if (tagError) {
    console.log("article_tags insert failed", tagError.code, tagError.message);
    return;
  }

  await sendMessage(chatId, copy.tagAdded(tag.label, articleTitle));
}

// D26: `kind = 'tag_list'`, text is a bare integer → open that item as a
// full article message. Any other text against a tag_list message (not a
// bare integer) is ignored — the input table only pins the numeric case.
async function handleTagListReply(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  payload: unknown,
  text: string,
) {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return;
  }

  const articleIds = (payload as { article_ids?: number[] } | null)?.article_ids ?? [];
  const articleId = articleIds[Number(trimmed) - 1];
  if (articleId === undefined) {
    return;
  }

  await sendArticleMessage(db, chatId, articleId);
}

// D26: resolves a reply to a bot message via `sent_messages` on
// (chat_id, telegram_message_id).
async function handleReply(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  repliedToMessageId: number,
  replyMessageId: number,
  text: string,
) {
  const { data: sentMessage, error } = await db
    .from("sent_messages")
    .select("kind, article_id, payload, articles(title)")
    .eq("chat_id", Number(chatId))
    .eq("telegram_message_id", repliedToMessageId)
    .maybeSingle();

  if (error) {
    console.log("sent_messages lookup failed", error.code, error.message);
    return;
  }
  if (!sentMessage) {
    // D26: no matching row. Ignore entirely.
    return;
  }

  if (sentMessage.kind === "tag_list") {
    await handleTagListReply(db, chatId, sentMessage.payload, text);
    return;
  }
  if (sentMessage.kind !== "article") {
    return;
  }

  if (text.startsWith("/tag ")) {
    const articleTitle = (sentMessage.articles as unknown as { title: string }).title;
    await applyTagToArticle(
      db,
      chatId,
      sentMessage.article_id,
      articleTitle,
      text.slice("/tag ".length),
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

// D28: top 5 via search_articles, each sent as its own article message.
async function handleSearch(db: ReturnType<typeof getServiceClient>, chatId: string, query: string) {
  const q = query.trim();
  if (!q) {
    return;
  }

  const { data: results, error } = await db.rpc("search_articles", { q });
  if (error) {
    console.log("search_articles rpc failed", error.code, error.message);
    return;
  }
  if (!results || results.length === 0) {
    await sendMessage(chatId, copy.searchEmpty(q));
    return;
  }

  for (const row of results as Array<{ id: number }>) {
    await sendArticleMessage(db, chatId, row.id);
  }
}

// D29: one message, one button per tag, two per row, labelled with counts.
async function handleTagsCommand(db: ReturnType<typeof getServiceClient>, chatId: string) {
  const menu = await fetchTagMenu(db);
  const buttons = menu.map((t) => ({ text: `${t.label} (${t.count})`, callback_data: `t:${t.id}:0` }));

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  await sendMessage(chatId, copy.tagsHeader(), { replyMarkup: rows });
}

async function handleStats(db: ReturnType<typeof getServiceClient>, chatId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ count: unread }, { count: read }, { count: week }] = await Promise.all([
    db.from("articles").select("id", { count: "exact", head: true }).eq("status", "unread"),
    db.from("articles").select("id", { count: "exact", head: true }).eq("status", "read"),
    db.from("articles").select("id", { count: "exact", head: true }).gte("saved_at", sevenDaysAgo),
  ]);

  await sendMessage(chatId, copy.stats(unread ?? 0, read ?? 0, week ?? 0));
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

  // Step 8: PDF documents are handled independently of reply/text context —
  // the input table pins no reply behaviour for them. Non-PDF documents
  // (by mime_type, falling back to filename) are a silent no-op, same as
  // any other unpinned input shape.
  const document = message.document as Record<string, unknown> | undefined;
  if (document) {
    const mimeType = document.mime_type as string | undefined;
    const fileName = document.file_name as string | undefined;
    const isPdf = mimeType === "application/pdf" || (!mimeType && /\.pdf$/i.test(fileName ?? ""));
    if (isPdf) {
      const caption = message.caption as string | undefined;
      const ok = await savePdf(db, chatId, document, caption);
      if (!ok) {
        await db.from("processed_updates").delete().eq("update_id", updateId);
      }
    }
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

  // /search, /tags, /stats, /help aren't scoped to a specific numbered
  // build step in SPEC.md's build order, but they're fully pinned in the
  // input table (section 5) and share this step's command-dispatch code,
  // so they're completed here rather than left dangling.
  if (text.startsWith("/search ")) {
    await handleSearch(db, chatId, text.slice("/search ".length));
    return;
  }
  if (text === "/tags") {
    await handleTagsCommand(db, chatId);
    return;
  }
  if (text === "/stats") {
    await handleStats(db, chatId);
    return;
  }
  if (text === "/help") {
    await sendMessage(chatId, copy.help());
    return;
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    await sendMessage(chatId, copy.nudge());
    return;
  }

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
