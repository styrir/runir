const SECRET_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "REQUESTY_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "RUNIR_LLM_API_KEY",
] as const;

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI-style secret prefixes (require sk- + long token; avoid short false positives)
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  // Authorization bearer tokens in serialized headers/logs
  /\bBearer\s+[-A-Za-z0-9._~+/=]{12,}/gi,
  // Explicit key assignments only (not env var names like REQUESTY_API_KEY on their own line)
  /\bapi[_-]?key\s*[:=]\s*["']?[-A-Za-z0-9._~+/=]{12,}/gi,
];

export function credentialSourceLabel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REQUESTY_API_KEY) return "env:REQUESTY_API_KEY";
  if (env.OPENROUTER_API_KEY) return "env:OPENROUTER_API_KEY";
  if (env.RUNIR_LLM_API_KEY) return "env:RUNIR_LLM_API_KEY";
  return "missing";
}

export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key =
    env.REQUESTY_API_KEY ||
    env.OPENROUTER_API_KEY ||
    env.RUNIR_LLM_API_KEY ||
    "";
  return key.trim() ? key.trim() : undefined;
}

/** Deep-clone JSON-compatible value with secrets redacted. */
export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  const secrets = [
    ...knownSecrets.filter(Boolean),
    ...SECRET_ENV_KEYS.map((k) => process.env[k]).filter((v): v is string => Boolean(v && v.length > 3)),
  ];
  const json = JSON.stringify(value, (_key, v) => {
    if (typeof v !== "string") return v;
    return redactString(v, secrets);
  });
  return JSON.parse(json) as T;
}

export function redactString(input: string, knownSecrets: string[] = []): string {
  let out = input;
  for (const s of knownSecrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("[REDACTED]");
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  // Authorization header shapes
  out = out.replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)(\S+)/gi, "$1[REDACTED]");
  return out;
}

export function assertNoSecrets(text: string, knownSecrets: string[] = []): void {
  for (const s of knownSecrets) {
    if (s && s.length >= 4 && text.includes(s)) {
      throw new Error("Secret material leaked into output");
    }
  }
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) {
      throw new Error("Secret-like pattern leaked into output");
    }
  }
}
