/** Whitespace-collapsed, trimmed, lowercased form of `text`. Shared dedupe-
 *  comparison primitive for the write-arbitrator and the overlay-supersession
 *  decision module — extracted so the two surfaces cannot drift. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
