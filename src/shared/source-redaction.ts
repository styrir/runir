import { isIP } from "node:net";

/**
 * Production redaction rules for fact and source write boundaries.
 *
 * Detects PII/sensitive patterns in text and replaces them with stable MARKER
 * tokens ([EMAIL_1], [URL_1], etc.). Designed to be layered on top of the
 * capture normalization.
 *
 * Coreference: the same raw match within a single call always receives the
 * same marker number (preserveCoreference: true by default), so downstream
 * assertion text stays consistent.
 *
 * USER kind is documented as a future-improvement stub — detecting proper
 * nouns / person names aggressively produces too many false positives.
 */

export type MarkerKind =
  | "USER"
  | "EMAIL"
  | "URL"
  | "PATH"
  | "IP"
  | "PHONE"
  | "SSN"
  | "API_KEY"
  | "AWS_KEY"
  | "OPENAI_KEY"
  | "BEARER_TOKEN"
  | "PASSWORD_ASSIGNMENT"
  | "PROVIDER_TOKEN"
  | "PRIVATE_KEY"
  | "AUTH_URL"
  | "CONNECTION_STRING"
  | "SECRET_ASSIGNMENT";

export const SOURCE_REDACTION_VERSION = 1;

/**
 * Secret-shaped kinds only (no PII kinds). Used by surfaces that must strip
 * credentials before content reaches disk but must NOT rewrite ordinary
 * personal content (e.g. the vault exporter, brief §9.2 redaction-before-disk:
 * a personal Obsidian vault legitimately contains paths, URLs, and emails).
 * Pattern provenance: marker-redaction key patterns + the shadow-adjudication
 * privacy scrubber (scripts/g004/shadow_artifact_privacy.ts
 * assertNoSecretLikeValues bearer/password shapes).
 */
export const SECRET_MARKER_KINDS: MarkerKind[] = [
  "BEARER_TOKEN",
  "OPENAI_KEY",
  "AWS_KEY",
  "API_KEY",
  "PASSWORD_ASSIGNMENT",
  "PROVIDER_TOKEN",
  "PRIVATE_KEY",
  "AUTH_URL",
  "CONNECTION_STRING",
  "SECRET_ASSIGNMENT",
];

export type RedactionResult = {
  text: string;
  markersAssigned: Record<MarkerKind, number>;
};

type PatternEntry = {
  kind: MarkerKind;
  // Using functions so each call gets a fresh regex with lastIndex = 0
  regex: () => RegExp;
};

/**
 * Order matters: more specific patterns must come before broader ones.
 * OPENAI_KEY (sk-proj-...) before API_KEY (sk-...) to avoid truncation.
 * SSN (\d{3}-\d{2}-\d{4}) before PHONE (\d{3}-\d{3}-\d{4}) — different
 * segment lengths, but listed early so SSN wins on ambiguous digits.
 */
const PATTERN_ENTRIES: PatternEntry[] = [
  { kind: "PRIVATE_KEY", regex: () => /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { kind: "PRIVATE_KEY", regex: () => /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { kind: "CONNECTION_STRING", regex: () => /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi },
  { kind: "AUTH_URL", regex: () => /https?:\/\/[^\s/@]+:[^\s/@]+@[^\s"'<>]+/gi },
  { kind: "PROVIDER_TOKEN", regex: () => /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g },
  { kind: "SECRET_ASSIGNMENT", regex: () => /\b(?:api[_-]?key|secret|token|access[_-]?key|client[_-]?secret)\s*[:=]\s*(?:"[^"]{12,}"|'[^']{12,}'|[A-Za-z0-9_./+=-]{12,})/gi },
  {
    // Before the key kinds so "Bearer sk-..." is swallowed as one token.
    kind: "BEARER_TOKEN",
    regex: () => /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  },
  {
    kind: "OPENAI_KEY",
    regex: () => /\bsk-proj-[a-zA-Z0-9]{20,}\b/g,
  },
  {
    kind: "AWS_KEY",
    regex: () => /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    kind: "API_KEY",
    // Generic OpenAI-style secret key that is NOT the sk-proj- variant
    regex: () => /\bsk-(?!proj-)[a-zA-Z0-9]{20,}\b/g,
  },
  {
    // After the key kinds: a key-shaped value is already tokenized, this
    // catches the remaining "password: hunter2" / "password=..." shapes.
    kind: "PASSWORD_ASSIGNMENT",
    regex: () => /\b(?:password|passwd|pwd)\s*[:=]\s*(?:"[^"]{4,}"|'[^']{4,}'|[^\s"']{4,})/gi,
  },
  {
    kind: "EMAIL",
    // A word boundary prevents quadratic retries on long identifier/code runs
    // with no '@', which are common in retained source turns.
    regex: () => /\b[\w.+-]+@[\w-]+\.[\w.-]+/g,
  },
  {
    kind: "URL",
    regex: () => /(https?:\/\/[^\s)]+)/g,
  },
  {
    kind: "PATH",
    regex: () => /\/(Users|home)\/[\w./-]+/g,
  },
  {
    kind: "IP",
    regex: () => /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    kind: "SSN",
    regex: () => /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    kind: "PHONE",
    regex: () => /\b\d{3}-\d{3}-\d{4}\b/g,
  },
  // USER: stub — proper-noun detection is high-false-positive; deferred.
];

function emptyMarkerCounts(): Record<MarkerKind, number> {
  return {
    USER: 0,
    EMAIL: 0,
    URL: 0,
    PATH: 0,
    IP: 0,
    PHONE: 0,
    SSN: 0,
    API_KEY: 0,
    AWS_KEY: 0,
    OPENAI_KEY: 0,
    BEARER_TOKEN: 0,
    PASSWORD_ASSIGNMENT: 0,
    PROVIDER_TOKEN: 0,
    PRIVATE_KEY: 0,
    AUTH_URL: 0,
    CONNECTION_STRING: 0,
    SECRET_ASSIGNMENT: 0,
  };
}

export class RedactionAssertionError extends Error {
  constructor() { super("redaction_assertion_failed"); }
}

const SECOND_PASS_SECRET_PATTERNS = [
  /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{12,}/i,
  /\b(?:secret|token|api[_-]?key|password)\s*[:=]\s*[^\s"']{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/,
];

export function assertNoSecrets(text: string): void {
  if (redactWithMarkers(text, { kinds: SECRET_MARKER_KINDS }).text !== text
      || SECOND_PASS_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new RedactionAssertionError();
  }
}

export function redactFactText(text: string): string {
  const withoutSource = text.replace(/\n\s*Source:\s*\n[\s\S]*$/i, "");
  const result = redactWithMarkers(withoutSource, { kinds: SECRET_MARKER_KINDS }).text;
  assertNoSecrets(result);
  return result;
}

export function redactFact<T extends object>(fact: T): T {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactFactText(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "raw_source_text")
        .map(([key, nested]) => [key, walk(nested)]));
    }
    return value;
  };
  const result = walk(fact) as T;
  assertNoSecrets(JSON.stringify(result));
  return result;
}

export function redactSourceTurn(text: string): string {
  const markers = new Map<string, string>();
  const counts: Record<string, number> = { USER: 0, URL: 0, IP: 0, PHONE: 0 };
  const marker = (kind: "USER" | "URL" | "IP" | "PHONE", value: string): string => {
    const key = `${kind}:${value}`;
    const prior = markers.get(key);
    if (prior) return prior;
    const next = `[${kind}_${++counts[kind]}]`;
    markers.set(key, next);
    return next;
  };
  const sanitizedUrls = text.replace(/https?:\/\/[^\s)<>"']+/gi, (value) => {
    try {
      const url = new URL(value);
      if (url.username || url.password) return marker("URL", value);
      url.search = "";
      url.hash = "";
      const clean = `${url.protocol}//${url.host}${url.pathname}`;
      return redactWithMarkers(clean, { kinds: SECRET_MARKER_KINDS }).text === clean ? clean : marker("URL", value);
    } catch { return marker("URL", value); }
  });
  const home = sanitizedUrls.replace(/(\/(?:Users|home)\/)([^\s/]+)/g, (_match, prefix: string, username: string) =>
    `${prefix}${marker("USER", username)}`);
  const pass = redactWithMarkers(home, {
    kinds: [...SECRET_MARKER_KINDS, "EMAIL", "PHONE", "SSN", "IP"],
  });
  counts.IP = pass.markersAssigned.IP;
  counts.PHONE = pass.markersAssigned.PHONE;
  const withPhone = pass.text.replace(/(?<!\w)\+?\d{1,3}[ .-]?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
    (candidate) => marker("PHONE", candidate));
  const result = withPhone.replace(/(?<![0-9A-Za-z:])[0-9a-f:]*:[0-9a-f:]+(?![0-9A-Za-z:])/gi, (candidate) =>
    isIP(candidate) === 6 ? marker("IP", candidate) : candidate);
  assertNoSecrets(result);
  return result;
}

/**
 * Redact PII/sensitive patterns from `text`, replacing each match with a
 * stable MARKER token ([KIND_N]).
 *
 * @param text - Input string to redact.
 * @param opts.preserveCoreference - When true (default), the same raw match
 *   value always gets the same marker number within this call, preserving
 *   coreference for downstream assertion text.
 * @param opts.kinds - When provided, only these kinds are redacted (pattern
 *   order is preserved). Omit for the full PII+secret sweep.
 *
 * @returns { text, markersAssigned } where markersAssigned counts how many
 *   distinct markers were assigned per kind.
 */
export function redactWithMarkers(
  text: string,
  opts?: { preserveCoreference?: boolean; kinds?: MarkerKind[] },
): RedactionResult {
  const preserveCoreference = opts?.preserveCoreference ?? true;
  const counts = emptyMarkerCounts();
  const activeEntries = opts?.kinds
    ? PATTERN_ENTRIES.filter((entry) => opts.kinds!.includes(entry.kind))
    : PATTERN_ENTRIES;

  // Map from kind → (raw match value → marker token) for coreference
  const seenByKind = new Map<MarkerKind, Map<string, string>>();

  let current = text;

  for (const entry of activeEntries) {
    const { kind } = entry;
    const regex = entry.regex();

    if (!seenByKind.has(kind)) {
      seenByKind.set(kind, new Map());
    }
    const seen = seenByKind.get(kind)!;

    current = current.replace(regex, (match) => {
      if (preserveCoreference && seen.has(match)) {
        return seen.get(match)!;
      }
      counts[kind] += 1;
      const token = `[${kind}_${counts[kind]}]`;
      if (preserveCoreference) {
        seen.set(match, token);
      }
      return token;
    });
  }

  return { text: current, markersAssigned: counts };
}
