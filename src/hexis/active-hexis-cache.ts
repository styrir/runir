import { createHash } from "node:crypto";
import type { HexisHint, HexisState } from "./runtime-hexis.js";

const CACHE_TTL_MS = 5_000;
const CACHE_MAX_ENTRIES = 256;

type ActiveHexisCacheInput = {
  userId: string;
  sessionId?: string;
  path?: string;
  projectId?: string;
  agentId?: string;
  hexisHint?: HexisHint;
  allowHintRichCacheRead?: boolean;
};

type CacheEntry = {
  expiresAt: number;
  value: HexisState | null;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<HexisState | null>>();

function cloneHexisState<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeScopeField(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => [key, stableValue(entryValue)]);
  return Object.fromEntries(entries);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function touchLru(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function pruneExpired(now: number): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function enforceMaxEntries(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function hintFingerprint(hint: HexisHint | undefined): string {
  return createHash("sha256")
    .update(stableStringify(hint ?? null))
    .digest("hex");
}

export function hasAdditionalHexisHintSignal(hint: HexisHint | undefined): boolean {
  return Boolean(
    hint
    && (
      hint.scope
      || hint.label
      || (hint.goals?.length ?? 0) > 0
      || (hint.roles?.length ?? 0) > 0
      || (hint.hypotheses?.length ?? 0) > 0
      || Object.keys(hint.topicBias ?? {}).length > 0
      || Object.keys(hint.memoryRoleWeights ?? {}).length > 0
      || Object.keys(hint.relevanceWeights ?? {}).length > 0
      || hint.admissibility
      || hint.version != null
    ),
  );
}

export function buildActiveHexisCacheKey(input: ActiveHexisCacheInput): string {
  return createHash("sha256")
    .update(stableStringify({
      userId: input.userId,
      sessionId: normalizeScopeField(input.sessionId),
      path: normalizeScopeField(input.path),
      projectId: normalizeScopeField(input.projectId),
      agentId: normalizeScopeField(input.agentId),
      hintFingerprint: hintFingerprint(input.hexisHint),
    }))
    .digest("hex");
}

export async function resolveActiveHexisCached(
  input: ActiveHexisCacheInput,
  resolver: () => Promise<HexisState | null>,
): Promise<HexisState | null> {
  const now = Date.now();
  pruneExpired(now);

  const key = buildActiveHexisCacheKey(input);
  const bypassRead = hasAdditionalHexisHintSignal(input.hexisHint) && input.allowHintRichCacheRead !== true;

  if (!bypassRead) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      touchLru(key, cached);
      return cloneHexisState(cached.value);
    }
  }

  const existing = inFlight.get(key);
  if (existing) {
    return cloneHexisState(await existing);
  }

  const pending = (async () => {
    const resolved = await resolver();
    const entry: CacheEntry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: cloneHexisState(resolved),
    };
    cache.set(key, entry);
    enforceMaxEntries();
    return cloneHexisState(resolved);
  })();

  inFlight.set(key, pending);
  try {
    return cloneHexisState(await pending);
  } finally {
    inFlight.delete(key);
  }
}

export function clearActiveHexisCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}

export const ACTIVE_HEXIS_CACHE_TESTING = {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
};
