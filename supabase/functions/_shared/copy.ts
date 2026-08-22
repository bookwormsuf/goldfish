// All user-facing strings live here. No string literals in handler code. (D36)
// Verbatim from SPEC.md section 6 — do not invent additional strings.

export const copy = {
  saved: (title: string, topics: string) => `Saved · ${title}\n${topics}`,

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

  topicAdded: (label: string, title: string) => `Tagged ${title} · ${label}`,

  searchEmpty: (q: string) => `Nothing for "${q}".`,

  topicsHeader: () => `Topics`,

  topicListHeader: (label: string, count: number) =>
    `${label} · ${count} article${count === 1 ? "" : "s"}`,

  topicListFooter: () => `Reply with a number to open one.`,

  topicListEmpty: (label: string) => `Nothing in ${label} yet.`,

  stats: (unread: number, read: number, week: number) =>
    `${unread} unread · ${read} read · ${week} saved this week`,

  help: () =>
    `Send a link to save it.\n` +
    `Reply to an article to add a note.\n` +
    `Reply /topic <name> to tag it.\n\n` +
    `/search <query>\n/topics\n/stats`,

  markedRead: () => `Marked read`,
  markedSkipped: () => `Marked skipped`,
  btnRead: () => `Read`,
  btnSkip: () => `Skip`,
  btnDoneRead: () => `✓ Read`,
  btnDoneSkipped: () => `✗ Skipped`,
  btnPrev: () => `◀ Prev`,
  btnNext: () => `Next ▶`,
};
