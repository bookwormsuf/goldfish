// Raw fetch wrappers around the Telegram Bot API. No framework. (D1)
// Only the methods actually in use are implemented; more are added as later
// build steps need them (sendDocument, answerCallbackQuery,
// editMessageReplyMarkup, setMessageReaction, getFile).

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  opts: { parseMode?: "HTML" } = {},
): Promise<unknown> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) {
    body.parse_mode = opts.parseMode;
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
