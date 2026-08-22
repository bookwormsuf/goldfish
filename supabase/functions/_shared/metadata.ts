// URL normalisation (D7), domain extraction (D9), and page metadata fetch (D8).

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MAX_BYTES = 64 * 1024;

// D7: scheme and host are lowercased by the WHATWG URL parser itself, so no
// explicit lowercasing is needed here. Path case is left untouched because
// nothing here touches pathname casing.
export function normalizeUrlKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  u.hash = "";
  for (const param of TRACKING_PARAMS) {
    u.searchParams.delete(param);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

// D9: hostname with a leading www. removed, lowercased (already lowercase
// from the URL parser).
export function domainOf(rawUrl: string): string {
  return new URL(rawUrl).hostname.replace(/^www\./, "");
}

function hostnameOf(rawUrl: string): string {
  return new URL(rawUrl).hostname;
}

async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let result = "";
  try {
    while (received < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed, nothing to do.
    }
  }
  return result;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchMetaContent(html: string, attr: "property" | "name", value: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+${attr}=["']${value}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${value}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return decodeEntities(match[1]);
    }
  }
  return null;
}

function extractTitle(html: string, fallback: string): string {
  const og = matchMetaContent(html, "property", "og:title");
  if (og) return og;
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleTag) return decodeEntities(titleTag[1]);
  return fallback;
}

function extractDescription(html: string): string | null {
  const og = matchMetaContent(html, "property", "og:description");
  if (og) return og;
  return matchMetaContent(html, "name", "description");
}

export interface FetchedMetadata {
  title: string;
  description: string | null;
  fetchOk: boolean;
}

// D8: fetch and extract. Any failure (timeout, non-2xx, throw) falls back to
// title = hostname, description = null, fetchOk = false. The caller still
// saves the article.
export async function fetchMetadata(url: string): Promise<FetchedMetadata> {
  const hostname = hostnameOf(url);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      return { title: hostname, description: null, fetchOk: false };
    }
    const html = await readUpTo(res.body, MAX_BYTES);
    return {
      title: extractTitle(html, hostname),
      description: extractDescription(html),
      fetchOk: true,
    };
  } catch {
    return { title: hostname, description: null, fetchOk: false };
  }
}
