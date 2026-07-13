import type {
  ContinuityDirective,
  ContinuityDirectiveKind,
  ContinuityDirectiveOwner,
  ContinuityDirectivePolarity,
  ContinuityDirectiveSource,
  ContinuityDirectiveStatus,
} from "../domain/memory/types.js";

const DIRECTIVE_KINDS = new Set<ContinuityDirectiveKind>([
  "action",
  "blocker",
  "constraint",
  "avoidance",
  "question",
  "verification",
  "dependency",
  "handoff",
  "decision",
]);

const DIRECTIVE_POLARITIES = new Set<ContinuityDirectivePolarity>([
  "do",
  "do_not",
  "wait_for",
  "ask",
  "verify",
  "decide",
  "remember",
]);

const DIRECTIVE_STATUSES = new Set<ContinuityDirectiveStatus>(["open", "blocked", "done", "stale"]);
const DIRECTIVE_OWNERS = new Set<ContinuityDirectiveOwner>(["user", "assistant", "external", "unknown"]);
const DIRECTIVE_SOURCES = new Set<ContinuityDirectiveSource>(["explicit", "inferred"]);

function compactDirectiveText(value: unknown, maxLength = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function defaultPolarityForKind(kind: ContinuityDirectiveKind): ContinuityDirectivePolarity {
  switch (kind) {
    case "avoidance":
    case "constraint":
      return "do_not";
    case "blocker":
    case "dependency":
      return "wait_for";
    case "question":
      return "ask";
    case "verification":
      return "verify";
    case "decision":
      return "decide";
    case "handoff":
      return "remember";
    case "action":
    default:
      return "do";
  }
}

function normalizeConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.7;
  return Math.max(0, Math.min(1, parsed));
}

export function normalizeContinuityDirective(input: unknown): ContinuityDirective | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const text = compactDirectiveText(raw.text, 400);
  if (!text) return null;

  const kind = DIRECTIVE_KINDS.has(raw.kind as ContinuityDirectiveKind)
    ? raw.kind as ContinuityDirectiveKind
    : "action";
  const polarity = DIRECTIVE_POLARITIES.has(raw.polarity as ContinuityDirectivePolarity)
    ? raw.polarity as ContinuityDirectivePolarity
    : defaultPolarityForKind(kind);
  const status = DIRECTIVE_STATUSES.has(raw.status as ContinuityDirectiveStatus)
    ? raw.status as ContinuityDirectiveStatus
    : (kind === "blocker" || kind === "dependency" ? "blocked" : "open");
  const source = DIRECTIVE_SOURCES.has(raw.source as ContinuityDirectiveSource)
    ? raw.source as ContinuityDirectiveSource
    : "explicit";
  const evidence = compactDirectiveText(raw.evidence, 400) ?? text;

  const directive: ContinuityDirective = {
    kind,
    polarity,
    status,
    text,
    source,
    confidence: normalizeConfidence(raw.confidence),
    evidence,
  };

  const condition = compactDirectiveText(raw.condition);
  const subject = compactDirectiveText(raw.subject);
  const target = compactDirectiveText(raw.target);
  if (condition) directive.condition = condition;
  if (subject) directive.subject = subject;
  if (target) directive.target = target;
  if (DIRECTIVE_OWNERS.has(raw.owner as ContinuityDirectiveOwner)) {
    directive.owner = raw.owner as ContinuityDirectiveOwner;
  }

  return directive;
}

export function normalizeContinuityDirectives(input: unknown): ContinuityDirective[] {
  if (!Array.isArray(input)) return [];
  const directives: ContinuityDirective[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    const directive = normalizeContinuityDirective(candidate);
    if (!directive) continue;
    const key = `${directive.kind}\u0000${directive.polarity}\u0000${directive.status}\u0000${directive.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    directives.push(directive);
    if (directives.length >= 10) break;
  }
  return directives;
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function formatWaitDirective(directive: ContinuityDirective): string {
  const target = directive.target ?? directive.condition;
  if (target) return ensureSentence(`Wait for ${target}`);
  return ensureSentence(directive.text);
}

export function directiveToStateLine(directive: ContinuityDirective): string | undefined {
  if (directive.status === "stale") return undefined;
  switch (directive.kind) {
    case "avoidance":
    case "constraint":
      return ensureSentence(`Avoid: ${directive.text}`);
    case "question":
      return ensureSentence(`Question: ${directive.text}`);
    case "verification":
      return ensureSentence(`Verify: ${directive.text}`);
    case "decision":
      return ensureSentence(`Decision: ${directive.text}`);
    case "blocker":
    case "dependency":
      return ensureSentence(directive.text);
    default:
      return ensureSentence(directive.text);
  }
}

export function directiveToNextStep(directive: ContinuityDirective): string | undefined {
  if (directive.status !== "open" && directive.status !== "blocked") return undefined;
  switch (directive.polarity) {
    case "do":
      return ensureSentence(directive.text);
    case "do_not":
      return ensureSentence(`Avoid: ${directive.text}`);
    case "wait_for":
      return formatWaitDirective(directive);
    case "ask":
      return ensureSentence(`Ask: ${directive.text}`);
    case "verify":
      return ensureSentence(`Verify: ${directive.text}`);
    case "decide":
    case "remember":
    default:
      return undefined;
  }
}

export function directiveToLegacyBlocker(directive: ContinuityDirective): string | undefined {
  if (directive.status === "stale" || directive.status === "done") return undefined;
  if (directive.kind !== "blocker" && directive.kind !== "dependency" && directive.polarity !== "wait_for") {
    return undefined;
  }
  return ensureSentence(directive.text);
}
