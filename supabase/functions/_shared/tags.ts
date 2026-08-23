// D12-D15: tag assignment via Haiku with forced tool output, slug
// validation against the live tags table, and the `/tag` reply command.

import { getServiceClient } from "./db.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-haiku-4-5-20251001";

export interface TagRow {
  id: number;
  slug: string;
  label: string;
}

// D13, verbatim from SPEC.md except assign_topics -> assign_tags (part of
// this rename, so the Haiku-facing schema doesn't say "topics" while
// everything else says "tags"). Do not ask for JSON in the prompt.
const ASSIGN_TAGS_TOOL = {
  name: "assign_tags",
  description: "Assign 1-3 tags to an article.",
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
  tagRows: TagRow[],
): Promise<string[]> {
  const tagMenu = tagRows.map((t) => `${t.slug} - ${t.label}`).join("\n");
  const userContent =
    `Title: ${title}\nDescription: ${description ?? "(none)"}\n\n` +
    `Available tags:\n${tagMenu}`;

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
      tools: [ASSIGN_TAGS_TOOL],
      tool_choice: { type: "tool", name: "assign_tags" },
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
    throw new Error("assign_tags call had no slugs array");
  }
  return input.slugs as string[];
}

// D12, D14: never throws, never blocks a save. Falls back to `other` when
// the call fails or every returned slug is invalid; returns [] only if the
// tags table itself can't be read (nothing to fall back to).
export async function assignTags(
  db: ReturnType<typeof getServiceClient>,
  title: string,
  description: string | null,
): Promise<TagRow[]> {
  const { data: tagRows, error: tagsError } = await db
    .from("tags")
    .select("id, slug, label");

  if (tagsError || !tagRows) {
    console.log("tag list lookup failed", tagsError?.code, tagsError?.message);
    return [];
  }

  let slugs: string[] = [];
  try {
    slugs = await callHaiku(title, description, tagRows);
  } catch (err) {
    console.log("tag assignment call failed", String(err));
  }

  const bySlug = new Map(tagRows.map((t) => [t.slug, t]));
  const matched = slugs
    .map((s) => bySlug.get(s))
    .filter((t): t is TagRow => t !== undefined);

  if (matched.length > 0) {
    return matched;
  }

  const other = bySlug.get("other");
  return other ? [other] : [];
}

// Step 6 addition: derives a slug/label pair from free text typed after
// `/tag `. Not pinned in SPEC.md — kebab-cased slug for matching
// (mirrors the seed tags' shape), title-cased label for display, so
// user-created tags read consistently next to the fixed list rather than
// preserving whatever casing was typed.
export function deriveTagFields(name: string): { slug: string; label: string } | null {
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
export async function findOrCreateTag(
  db: ReturnType<typeof getServiceClient>,
  name: string,
): Promise<TagRow | null> {
  const fields = deriveTagFields(name);
  if (!fields) {
    return null;
  }

  const { data: existing, error: lookupError } = await db
    .from("tags")
    .select("id, slug, label")
    .eq("slug", fields.slug)
    .maybeSingle();

  if (lookupError) {
    console.log("tag lookup failed", lookupError.code, lookupError.message);
    return null;
  }
  if (existing) {
    return existing;
  }

  const { data: created, error: insertError } = await db
    .from("tags")
    .insert({ slug: fields.slug, label: fields.label })
    .select("id, slug, label")
    .single();

  if (insertError) {
    console.log("tag insert failed", insertError.code, insertError.message);
    return null;
  }
  return created;
}
