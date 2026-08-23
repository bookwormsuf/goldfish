// Raw fetch wrappers around the Telegram Bot API. No framework. (D1)
// Only the methods actually in use are implemented; more are added as later
// build steps need them (sendDocument is still unused — Step 8 chose a
// text-only rendering for browsed/searched PDFs, see SPEC.md's addendum
// after D34).

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageResult {
  ok: boolean;
  result?: { message_id: number };
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: { parseMode?: "HTML"; replyMarkup?: InlineKeyboardButton[][] } = {},
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) {
    body.parse_mode = opts.parseMode;
  }
  if (opts.replyMarkup) {
    body.reply_markup = { inline_keyboard: opts.replyMarkup };
  }

  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("sendMessage failed", data.error_code, data.description);
  }
  return data;
}

// D24: answers the loading spinner on a tapped button. `text` shows as a
// brief toast; omitted for the `noop` case which answers with nothing.
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) {
    body.text = text;
  }

  const res = await fetch(apiUrl("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("answerCallbackQuery failed", data.error_code, data.description);
  }
}

// D30: used to turn a /topics menu message into a topic list page in place.
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  opts: { parseMode?: "HTML" | "Markdown"; replyMarkup?: InlineKeyboardButton[][] } = {},
): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (opts.parseMode) {
    body.parse_mode = opts.parseMode;
  }
  if (opts.replyMarkup) {
    body.reply_markup = { inline_keyboard: opts.replyMarkup };
  }

  const res = await fetch(apiUrl("editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("editMessageText failed", data.error_code, data.description);
  }
}

// D24: replaces a message's inline keyboard in place. Never used to delete
// or otherwise edit the message text itself.
export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  replyMarkup: InlineKeyboardButton[][],
): Promise<void> {
  const res = await fetch(apiUrl("editMessageReplyMarkup"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: replyMarkup },
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("editMessageReplyMarkup failed", data.error_code, data.description);
  }
}

export interface GetFileResult {
  ok: boolean;
  result?: { file_id: string; file_path?: string; file_size?: number };
}

// D31: resolves a Telegram file_id to a download path.
export async function getFile(fileId: string): Promise<GetFileResult> {
  const res = await fetch(apiUrl("getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("getFile failed", data.error_code, data.description);
  }
  return data;
}

// D31: not one of the Bot API "methods" D1 closes the list to — this is the
// separate token-scoped file-serving endpoint, needed to actually fetch the
// bytes getFile's path points at before uploading to Storage.
export async function downloadFile(filePath: string): Promise<Uint8Array | null> {
  const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!res.ok) {
    console.log("downloadFile failed", res.status);
    return null;
  }
  return new Uint8Array(await res.arrayBuffer());
}

// D27: reacts to a message instead of sending a reply, so a note doesn't
// generate its own reply-chain noise.
export async function setMessageReaction(
  chatId: number | string,
  messageId: number,
  emoji: string,
): Promise<void> {
  const res = await fetch(apiUrl("setMessageReaction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.log("setMessageReaction failed", data.error_code, data.description);
  }
}
