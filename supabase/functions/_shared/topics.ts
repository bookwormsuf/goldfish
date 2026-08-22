// D12-D15: topic assignment via Haiku with forced tool output, slug
// validation against the live topics table, and the `/topic` reply command.

import { getServiceClient } from "./db.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001";

export interface TopicRow {
  id: number;
  slug: string;
  label: string;
}

// D13, verbatim from SPEC.md. Do not ask for JSON in the prompt.
const ASSIGN_TOPICS_TOOL = {
  name: "assign_topics",
  description: "Assign 1-3 topics to an article.",
  input_schema: {
    type: "object",
    properties: {
      slugs: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
      },
    },
    required: ["slugs"],
  },
};

async function callHaiku(
  title: string,
  description: string | null,
  topicRows: TopicRow[],
): Promise<string[]> {
  const topicMenu = topicRows.map((t) => `${t.slug} - ${t.label}`).join("\n");
  const userContent =
    `Title: ${title}\nDescription: ${description ?? "(none)"}\n\n` +
    `Available topics:\n${topicMenu}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      tools: [ASSIGN_TOPICS_TOOL],
      tool_choice: { type: "tool", name: "assign_topics" },
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API returned ${res.status}`);
  }

  const data = await res.json();
  const toolUse = (data.content as Array<Record<string, unknown>> | undefined)
    ?.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("no tool_use block in Anthropic response");
  }

  const input = toolUse.input as { slugs?: unknown };
  if (!Array.isArray(input.slugs)) {
    throw new Error("assign_topics call had no slugs array");
  }
  return input.slugs as string[];
}

// D12, D14: never throws, never blocks a save. Falls back to `other` when
// the call fails or every returned slug is invalid; returns [] only if the
// topics table itself can't be read (nothing to fall back to).
export async function assignTopics(
  db: ReturnType<typeof getServiceClient>,
  title: string,
  description: string | null,
): Promise<TopicRow[]> {
  const { data: topicRows, error: topicsError } = await db
    .from("topics")
    .select("id, slug, label");

  if (topicsError || !topicRows) {
    console.log("topic list lookup failed", topicsError?.code, topicsError?.message);
    return [];
  }

  let slugs: string[] = [];
  try {
    slugs = await callHaiku(title, description, topicRows);
  } catch (err) {
    console.log("topic assignment call failed", String(err));
  }

  const bySlug = new Map(topicRows.map((t) => [t.slug, t]));
  const matched = slugs
    .map((s) => bySlug.get(s))
    .filter((t): t is TopicRow => t !== undefined);

  if (matched.length > 0) {
    return matched;
  }

  const other = bySlug.get("other");
  return other ? [other] : [];
}

// Step 6 addition: derives a slug/label pair from free text typed after
// `/topic `. Not pinned in SPEC.md — kebab-cased slug for matching
// (mirrors the seed topics' shape), title-cased label for display, so
// user-created topics read consistently next to the fixed list rather than
// preserving whatever casing was typed.
export function deriveTopicFields(name: string): { slug: string; label: string } | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    return null;
  }

  const label = name
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  return { slug, label };
}

// D15: forward-only. Only ever called from the reply-to-tag path (D26),
// never re-tags older articles.
export async function findOrCreateTopic(
  db: ReturnType<typeof getServiceClient>,
  name: string,
): Promise<TopicRow | null> {
  const fields = deriveTopicFields(name);
  if (!fields) {
    return null;
  }

  const { data: existing, error: lookupError } = await db
    .from("topics")
    .select("id, slug, label")
    .eq("slug", fields.slug)
    .maybeSingle();

  if (lookupError) {
    console.log("topic lookup failed", lookupError.code, lookupError.message);
    return null;
  }
  if (existing) {
    return existing;
  }

  const { data: created, error: insertError } = await db
    .from("topics")
    .insert({ slug: fields.slug, label: fields.label })
    .select("id, slug, label")
    .single();

  if (insertError) {
    console.log("topic insert failed", insertError.code, insertError.message);
    return null;
  }
  return created;
}
