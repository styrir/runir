function normalizeArticle(text: string): string {
  return text.replace(/^(?:the|a|an)\s+/i, "").trim();
}

function summarizeContinuityText(text: string, maxLength = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatRolloutCompletion(subject: string, target: string): string {
  const normalizedSubject = normalizeArticle(subject);
  const normalizedTarget = normalizeArticle(target);
  const rolloutSubject = /\brollout\b/i.test(normalizedSubject)
    ? normalizedSubject
    : `${normalizedSubject} rollout`;
  const targetPhrase = /\s/.test(normalizedTarget)
    ? `the ${normalizedTarget}`
    : normalizedTarget;
  return summarizeContinuityText(`Complete the ${rolloutSubject} to ${targetPhrase}.`, 120);
}

export function inferNextStepFromBlocker(text: string): string | undefined {
  if (!/\bblocked\b|\bblocker\b|\bwaiting on\b/i.test(text)) return undefined;
  const normalized = summarizeContinuityText(text, 400);

  const pendingRollout = normalized.match(
    /\bpending\s+rollout\s+of\s+(?:the\s+)?(.+?)\s+to\s+(?:the\s+)?(.+?)(?:[.;]|$)/i,
  );
  if (pendingRollout?.[1] && pendingRollout[2]) {
    return formatRolloutCompletion(pendingRollout[1], pendingRollout[2]);
  }

  const untilLands = normalized.match(
    /\bblocked\b.+?\buntil\s+(?:the\s+)?(.+?)\s+(?:lands|is rolled out)\s+(?:in|to)\s+(?:the\s+)?(.+?)(?:[.;]|$)/i,
  );
  if (untilLands?.[1] && untilLands[2]) {
    return formatRolloutCompletion(untilLands[1], untilLands[2]);
  }

  return undefined;
}
