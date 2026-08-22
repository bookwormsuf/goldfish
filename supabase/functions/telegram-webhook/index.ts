// Step 1 scope only: secret header check, chat ID allowlist, update_id
// dedup, URL extraction, insert with title from the hostname.
// Metadata fetch and topic assignment are not implemented yet (SPEC.md step 2, 6).

import { getServiceClient } from "../_shared/db.ts";

const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const ALLOWED_CHAT_ID = Deno.env.get("ALLOWED_CHAT_ID");

const URL_REGEX = /https?:\/\/[^\s<>"]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  // D37: strip trailing punctuation picked up from sentences or markdown links.
  return matches.map((url) => url.replace(TRAILING_PUNCTUATION, ""));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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

  const urls = extractUrls(text);
  let hadFailure = false;
  for (const url of urls) {
    const title = hostnameOf(url);
    const { error } = await db.from("articles").insert({
      kind: "link",
      url,
      title,
    });
    if (error) {
      console.log("article insert failed", error.code, error.message);
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
