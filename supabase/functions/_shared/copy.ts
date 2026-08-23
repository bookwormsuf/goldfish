// All user-facing strings live here. No string literals in handler code. (D36)
// Verbatim from SPEC.md section 6 — do not invent additional strings.

export const copy = {
  saved: (title: string, tags: string) => `Saved · ${title}\n${tags}`,

  savedUnfetchable: (title: string) =>
    `Couldn't read that page, saved the link anyway.\n${title}\n(unfetchable)`,

  duplicate: (date: string) => `Already saved, ${date}.`,

  savedPdf: (title: string) => `Saved PDF · ${title}`,

  pdfTooBig: () => `Too big for Telegram, 20MB limit.`,

  pdfUploadFailed: (title: string) => `Saved ${title} but the file upload failed.`,

  digestHeader: () => `Morning. Three for you.`,

  digestShort: (n: number) => `That's all you've got — ${n} unread.`,

  digestEmpty: () => `Nothing unread. Send me some links.`,

  nudge: () => `Send me a link, or reply to an article to add a note.`,

  tagAdded: (label: string, title: string) => `Tagged ${title} · ${label}`,

  searchEmpty: (q: string) => `Nothing for "${q}".`,

  tagsHeader: () => `Tags`,

  tagListHeader: (label: string, count: number) =>
    `${label} · ${count} article${count === 1 ? "" : "s"}`,

  tagListFooter: () => `Reply with a number to open one.`,

  tagListEmpty: (label: string) => `Nothing in ${label} yet.`,

  stats: (unread: number, read: number, week: number) =>
    `${unread} unread · ${read} read · ${week} saved this week`,

  help: () =>
    `Send a link to save it.\n` +
    `Reply to an article to add a note.\n` +
    `Reply /tag <name> to tag it.\n\n` +
    `/search <query>\n/tags\n/stats`,

  markedRead: () => `Marked read`,
  markedSkipped: () => `Marked skipped`,
  btnRead: () => `Read`,
  btnSkip: () => `Skip`,
  btnDoneRead: () => `✓ Read`,
  btnDoneSkipped: () => `✗ Skipped`,
  btnPrev: () => `◀ Prev`,
  btnNext: () => `Next ▶`,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Section 6: "Article message format" — one format, used everywhere (digest,
// search results, opened-from-list). Parse mode HTML. Description line is
// omitted entirely when null; the blank separator line stays either way.
export function articleMessageHtml(article: {
  title: string;
  description: string | null;
  tags: string;
  url: string | null;
}): string {
  const lines = [`<b>${escapeHtml(article.title)}</b>`];
  if (article.description) {
    lines.push(escapeHtml(article.description));
  }
  lines.push("");
  lines.push(escapeHtml(article.tags));
  // Step 8: PDFs have no url (SPEC.md addendum after D34).
  lines.push(article.url ? escapeHtml(article.url) : "(PDF)");
  return lines.join("\n");
}
