// D29, D30: /topics menu, paginated topic-list pages, and the shared
// "send a full article message with buttons" used by search results and
// numeric topic_list resolution.

import { DEFAULT_USER_ID, getServiceClient } from "./db.ts";
import { sendMessage } from "./telegram.ts";
import { articleMessageHtml, copy } from "./copy.ts";

const PAGE_SIZE = 10;

export interface TopicMenuItem {
  id: number;
  label: string;
  count: number;
}

// D29: counts all articles regardless of status. Counted client-side rather
// than via an embedded PostgREST aggregate — the topic count is small
// enough (single-user, a few thousand articles at most) that correctness
// isn't worth betting on a specific PostgREST version's aggregate syntax.
export async function fetchTopicMenu(
  db: ReturnType<typeof getServiceClient>,
): Promise<TopicMenuItem[]> {
  const { data: topics, error: topicsError } = await db
    .from("topics")
    .select("id, label")
    .order("id");
  if (topicsError || !topics) {
    console.log("topics lookup failed", topicsError?.code, topicsError?.message);
    return [];
  }

  const { data: tags, error: tagsError } = await db.from("article_topics").select("topic_id");
  if (tagsError) {
    console.log("article_topics count lookup failed", tagsError.code, tagsError.message);
  }

  const counts = new Map<number, number>();
  for (const row of tags ?? []) {
    counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
  }

  return topics.map((t) => ({ id: t.id, label: t.label, count: counts.get(t.id) ?? 0 }));
}

interface TopicArticleRow {
  id: number;
  title: string;
  url: string;
  status: string;
  saved_at: string;
}

export interface TopicPage {
  label: string;
  total: number;
  items: Array<{ id: number; title: string; url: string; status: string }>;
  hasPrev: boolean;
  hasNext: boolean;
}

// D30: unread before read/skipped, then saved_at descending within each
// group. PostgREST's .order() only takes column names, not a CASE
// expression, so the sort happens client-side after fetching the topic's
// full article list — fine at single-user scale.
export async function fetchTopicPage(
  db: ReturnType<typeof getServiceClient>,
  topicId: number,
  offset: number,
): Promise<TopicPage | null> {
  const { data: topic, error: topicError } = await db
    .from("topics")
    .select("label")
    .eq("id", topicId)
    .maybeSingle();
  if (topicError || !topic) {
    console.log("topic lookup failed", topicError?.code, topicError?.message);
    return null;
  }

  const { data: rows, error: rowsError } = await db
    .from("article_topics")
    .select("articles(id, title, url, status, saved_at)")
    .eq("topic_id", topicId);
  if (rowsError || !rows) {
    console.log("topic articles lookup failed", rowsError?.code, rowsError?.message);
    return null;
  }

  const articles = (rows as unknown as Array<{ articles: TopicArticleRow | null }>)
    .map((r) => r.articles)
    .filter((a): a is TopicArticleRow => a !== null);

  articles.sort((a, b) => {
    const aUnread = a.status === "unread" ? 0 : 1;
    const bUnread = b.status === "unread" ? 0 : 1;
    if (aUnread !== bUnread) return aUnread - bUnread;
    return b.saved_at.localeCompare(a.saved_at);
  });

  const total = articles.length;
  const page = articles.slice(offset, offset + PAGE_SIZE);

  return {
    label: topic.label,
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
export function renderTopicListMessage(
  topicId: number,
  offset: number,
  page: TopicPage,
): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  if (page.total === 0) {
    return { text: copy.topicListEmpty(page.label), keyboard: [] };
  }

  const lines = [copy.topicListHeader(page.label, page.total), ""];
  page.items.forEach((item, i) => {
    const num = offset + i + 1;
    lines.push(`${num}. [${escapeMarkdownLinkText(item.title)}](${item.url}) — ${statusWord(item.status)}`);
  });
  lines.push("");
  lines.push(copy.topicListFooter());

  const navRow: Array<{ text: string; callback_data: string }> = [];
  if (page.hasPrev) {
    navRow.push({ text: copy.btnPrev(), callback_data: `t:${topicId}:${offset - PAGE_SIZE}` });
  }
  if (page.hasNext) {
    navRow.push({ text: copy.btnNext(), callback_data: `t:${topicId}:${offset + PAGE_SIZE}` });
  }

  return { text: lines.join("\n"), keyboard: navRow.length > 0 ? [navRow] : [] };
}

// Shared by /search (D28) and topic_list numeric resolution (D26): sends a
// full article message with Read/Skip buttons and records it in
// sent_messages, same shape as a digest send.
export async function sendArticleMessage(
  db: ReturnType<typeof getServiceClient>,
  chatId: string,
  articleId: number,
): Promise<boolean> {
  const { data: article, error: articleError } = await db
    .from("articles")
    .select("title, description, url")
    .eq("id", articleId)
    .maybeSingle();
  if (articleError || !article) {
    console.log("article lookup failed", articleError?.code, articleError?.message);
    return false;
  }

  const { data: tagRows, error: tagsError } = await db
    .from("article_topics")
    .select("topics(label)")
    .eq("article_id", articleId);
  if (tagsError) {
    console.log("article topics lookup failed", tagsError.code, tagsError.message);
  }
  const topicLabels = (tagRows as unknown as Array<{ topics: { label: string } | null }> | null ?? [])
    .map((r) => r.topics?.label)
    .filter((l): l is string => !!l)
    .join(", ");

  const text = articleMessageHtml({
    title: article.title,
    description: article.description,
    topics: topicLabels,
    url: article.url,
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
