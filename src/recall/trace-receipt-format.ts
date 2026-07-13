/**
 * Pure formatters that turn a retrieval trace (the "recall receipt") into
 * human-readable text for the `runir traces` CLI — the Memory Impact Viewer.
 *
 * Runir injects recalled context into the MODEL's context invisibly; the human
 * never sees what was recalled or whether it helped. These formatters make that
 * invisible layer visible: prompt -> recalled memories -> the exact text that
 * was injected -> the model's answer. Kept side-effect-free so the presentation
 * is unit-testable without a live service.
 */

export interface TraceItemView {
  id: string;
  score: number;
  memoryRole?: string;
  path?: string;
  hexisFit?: number;
  rankingExplanation?: string[];
}

export interface TraceView {
  id: string;
  userId?: string;
  prompt?: string;
  intentLabel?: string;
  laneLabel?: string;
  retrievalPath?: string;
  requestedPath?: string;
  sessionId?: string;
  hexisLabel?: string;
  accessTrackedIds?: string[];
  prependContext?: string;
  answer?: string;
  responseResolution?: string;
  correctedIds?: string[];
  feedbackReceivedAt?: string;
  /** THIN human recall-quality label (helped|hurt|unused|missing|stale), set via `runir traces rate`. */
  rating?: string;
  ratingNote?: string;
  ratedAt?: string;
  items?: TraceItemView[];
  createdAt?: string;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Compact, one-block-per-trace summary for `runir traces` (the list view). */
export function formatTraceList(traces: TraceView[], userId: string): string {
  if (traces.length === 0) {
    return `No recall receipts found for ${userId}. Memory only records a trace when a turn actually recalled something.`;
  }
  const lines: string[] = [
    `Recall receipts for ${userId} (latest ${traces.length}, newest first):`,
    "",
  ];
  for (const t of traces) {
    const when = t.createdAt ?? "(no timestamp)";
    const recalled = t.items?.length ?? 0;
    const answered = t.feedbackReceivedAt ? "answered" : "no feedback yet";
    const rated = t.rating ? `  rated:${t.rating}` : "";
    const intent = t.intentLabel ?? "?";
    const path = t.retrievalPath ?? "?";
    lines.push(`• ${when}  [${intent}/${path}]  recalled ${recalled}  ${answered}${rated}`);
    lines.push(`    "${truncate(t.prompt ?? "", 76)}"`);
    lines.push(`    id: ${t.id}`);
    lines.push("");
  }
  lines.push("Run `runir traces --id <id>` for the full receipt (prompt → recalled memories → injected text → answer).");
  return lines.join("\n");
}

/** Full "what did memory do this turn" receipt for `runir traces --id <id>`. */
export function formatTraceReceipt(trace: TraceView): string {
  const lines: string[] = [];
  lines.push(`Recall receipt  ${trace.id}`);
  lines.push(`  when:    ${trace.createdAt ?? "—"}`);
  if (trace.userId) lines.push(`  user:    ${trace.userId}`);
  const meta = [
    `intent=${trace.intentLabel ?? "?"}`,
    `lane=${trace.laneLabel ?? "?"}`,
    `path=${trace.retrievalPath ?? "?"}`,
  ];
  if (trace.sessionId) meta.push(`session=${trace.sessionId}`);
  if (trace.hexisLabel) meta.push(`hexis=${trace.hexisLabel}`);
  lines.push(`  ${meta.join("   ")}`);
  lines.push("");

  lines.push("  prompt:");
  lines.push(indent(trace.prompt ?? "(none)", "    "));
  lines.push("");

  const items = trace.items ?? [];
  lines.push(`  recalled ${items.length} ${items.length === 1 ? "memory" : "memories"}:`);
  if (items.length === 0) {
    lines.push("    (none)");
  } else {
    items.forEach((item, i) => {
      const score = Number.isFinite(item.score) ? item.score.toFixed(3) : "?";
      const role = item.memoryRole ? `  role=${item.memoryRole}` : "";
      const fit = typeof item.hexisFit === "number" ? `  fit=${item.hexisFit.toFixed(2)}` : "";
      lines.push(`    [${i + 1}] score=${score}${role}${fit}  ${item.id}`);
      if (item.rankingExplanation?.length) {
        lines.push(indent(item.rankingExplanation.join(" · "), "        "));
      }
    });
  }
  lines.push("");

  lines.push("  injected into the model (verbatim):");
  if (trace.prependContext) {
    lines.push(indent(trace.prependContext, "  │ "));
  } else {
    lines.push("    (not stored — trace predates receipt capture, or nothing was injected)");
  }
  lines.push("");

  lines.push("  model answer:");
  lines.push(indent(trace.answer ?? "(no feedback received yet)", "    "));
  lines.push("");

  lines.push("  feedback:");
  lines.push(`    resolution: ${trace.responseResolution ?? "—"}`);
  lines.push(`    corrected:  ${trace.correctedIds?.length ? trace.correctedIds.join(", ") : "none"}`);
  lines.push(`    received:   ${trace.feedbackReceivedAt ?? "—"}`);
  lines.push("");

  // The human's recall-quality verdict (separate from feedback — never reinforces usefulness).
  lines.push("  your rating:");
  lines.push(`    verdict:  ${trace.rating ?? "— (not rated — `runir traces rate --id <id> --rating <r>`)"}`);
  if (trace.ratingNote) lines.push(`    note:     ${trace.ratingNote}`);
  if (trace.ratedAt) lines.push(`    rated:    ${trace.ratedAt}`);
  return lines.join("\n");
}
