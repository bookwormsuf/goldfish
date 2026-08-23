// D29, D30: /tags menu, paginated tag-list pages, and the shared
// "send a full article message with buttons" used by search results and
// numeric tag_list resolution.

import { DEFAULT_USER_ID, getServiceClient } from "./db.ts";
import { sendMessage } from "./telegram.ts";
import { articleMessageHtml, copy } from "./copy.ts";

const PAGE_SIZE = 10;

export interface TagMenuItem {
  id: number;
  label: string;
  count: number;
}

// D29: counts all articles regardless of status. Counted client-side rather
// than via an embedded PostgREST aggregate — the tag count is small
// enough (single-user, a few thousand articles at most) that correctness
// isn't worth betting on a specific PostgREST version's aggregate syntax.
export async function fetchTagMenu(
  db: ReturnType<typeof getServiceClient>,
): Promise<TagMenuItem[]> {
  const { data: tags, error: tagsError } = await db
    .from("tags")
    .select("id, label")
    .order("id");
  if (tagsError || !tags) {
    console.log("tags lookup failed", tagsError?.code, tagsError?.message);
    return [];
  }

  const { data: articleTags, error: articleTagsError } = await db.from("article_tags").select("tag_id");
  if (articleTagsError) {
    console.log("article_tags count lookup failed", articleTagsError.code, articleTagsError.message);
  }

  const counts = new Map<number, number>();
  for (const row of articleTags ?? []) {
    counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
  }

  return tags.map((t) => ({ id: t.id, label: t.label, count: counts.get(t.id) ?? 0 }));
}

interface TagArticleRow {
  id: number;
  title: string;
  url: string | null;
  status: string;
  saved_at: string;
}

export interface TagPage {
  label: string;
  total: number;
  items: Array<{ id: number; title: string; url: string | null; status: string }>;
  hasPrev: boolean;
  hasNext: boolean;
}

// D30: unread before read/skipped, then saved_at descending within each
// group. PostgREST's .order() only takes column names, not a CASE
// expression, so the sort happens client-side after fetching the tag's
// full article list — fine at single-user scale.
export async function fetchTagPage(
  db: ReturnType<typeof getServiceClient>,
  tagId: number,
  offset: number,
): Promise<TagPage | null> {
  const { data: tag, error: tagError } = await db
    .from("tags")
    .select("label")
    .eq("id", tagId)
    .maybeSingle();
  if (tagError || !tag) {
    console.log("tag lookup failed", tagError?.code, tagError?.message);
    return null;
  }

  const { data: rows, error: rowsError } = await db
    .from("article_tags")
    .select("articles(id, title, url, status, saved_at)")
    .eq("tag_id", tagId);
  if (rowsError || !rows) {
    console.log("tag articles lookup failed", rowsError?.code, rowsError?.message);
    return null;
  }

  const articles = (rows as unknown as Array<{ articles: TagArticleRow | null }>)
    .map((r) => r.articles)
    .filter((a): a is TagArticleRow => a !== null);

  articles.sort((a, b) => {
    const aUnread = a.status === "unread" ? 0 : 1;
    const bUnread = b.status === "unread" ? 0 : 1;
    if (aUnread !== bUnread) return aUnread - bUnread;
    return b.saved_at.localeCompare(a.saved_at);
  });

  const total = articles.length;
  const page = articles.slice(offset, offset + PAGE_SIZE);

  return {
    label: tag.label,
    total,
    items: page.map((a) => ({ id: a.id, title: a.title, url: a.url, status: a.status })),
    hasPrev: offset > 0,
    hasNext: offset + PAGE_SIZE < total,
  };
}

function escapeMarkdownLinkText(s: string): string {
  return s.replace(/[\[\]]/g, (c) => `\\${c}`);
}

function statusWord(status: string): string {
  return status === "unread" ? "unread" : status === "read" ? "read" : "skipped";
}

// D30: titles are markdown links, one per numbered line. Prev/Next buttons
// only appear when there's a page in that direction.
export function renderTagListMessage(
  tagId: number,
  offset: number,
  page: TagPage,
): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  if (page.total === 0) {
    return { text: copy.tagListEmpty(page.label), keyboard: [] };
  }

  const lines = [copy.tagListHeader(page.label, page.total), ""];
  page.items.forEach((item, i) => {
    const num = offset + i + 1;
    // Step 8: PDFs have no url, so they render as plain text instead of a
    // markdown link (SPEC.md addendum after D34).
    const titleText = item.url
      ? `[${escapeMarkdownLinkText(item.title)}](${item.url})`
      : escapeMarkdownLinkText(item.title);
    lines.push(`${num}. ${titleText} — ${statusWord(item.status)}`);
  });
  lines.push("");
  lines.push(copy.tagListFooter());

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (page.hasPrev) {
    navRow.push({ text: copy.btnPrev(), callback_data: `t:${tagId}:${offset - PAGE_SIZE}` });
  }
  if (page.hasNext) {
    navRow.push({ text: copy.btnNext(), callback_data: `t:${tagId}:${offset + PAGE_SIZE}` });
  }

  return { text: lines.join("\n"), keyboard: navRow.length > 0 ? [navRow] : [] };
}

// Shared by /search (D28) and tag_list numeric resolution (D26): sends a
// full article message with Read/Skip buttons and records it in
// sent_messages, same shape as a digest send.
export async function sendArticleMessage(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  articleId: number,
): Promise<boolean> {
  const { data: article, error: articleError } = await db
    .from("articles")
    .select("title, description, url, kind")
    .eq("id", articleId)
    .maybeSingle();
  if (articleError || !article) {
    console.log("article lookup failed", articleError?.code, articleError?.message);
    return false;
  }

  const { data: tagRows, error: tagsError } = await db
    .from("article_tags")
    .select("tags(label)")
    .eq("article_id", articleId);
  if (tagsError) {
    console.log("article tags lookup failed", tagsError.code, tagsError.message);
  }
  const tagLabels = (tagRows as unknown as Array<{ tags: { label: string } | null }> | null ?? [])
    .map((r) => r.tags?.label)
    .filter((l): l is string => !!l)
    .join(", ");

  const text = articleMessageHtml({
    title: article.title,
    description: article.description,
    tags: tagLabels,
    // Step 8: a PDF has no url. articleMessageHtml renders a "(PDF)" marker
    // in its place rather than resending the file (SPEC.md addendum after D34).
    url: article.kind === "pdf" ? null : article.url,
  });

  const sent = await sendMessage(chatId, text, {
    parseMode: "HTML",
    replyMarkup: [[
      { text: copy.btnRead(), callback_data: `r:${articleId}` },
      { text: copy.btnSkip(), callback_data: `s:${articleId}` },
    ]],
  });

  if (sent.ok && sent.result) {
    const { error: sentMessageError } = await db.from("sent_messages").insert({
      user_id: DEFAULT_USER_ID,
      chat_id: Number(chatId),
      telegram_message_id: sent.result.message_id,
      kind: "article",
      article_id: articleId,
    });
    if (sentMessageError) {
      console.log("sent_messages insert failed", sentMessageError.code, sentMessageError.message);
    }
  }

  return true;
}
