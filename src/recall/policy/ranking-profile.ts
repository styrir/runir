import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Per-tenant ranking profile (Rúnir-mmg2).
 *
 * Four ranking constants used to compile one tenant's data (the "owner"/runir
 * tenant) plus LoCoMo-benchmark fixtures into EVERY tenant's ranking:
 *   - STALE_SIGNALS / KNOWN_RENAMES (stale-signal demotion + contradiction collapse)
 *   - ENTITY_QUERY_FILLER_WORDS    (entity-mention candidate filtering)
 *   - TAXONOMY_EXPANSION_FACETS    (query expansion)
 *
 * Per AGENTS.md Benchmark Integrity, the generic MECHANISMS stay in source while
 * the tenant-specific DATA moves into per-tenant profiles loaded from an external
 * JSON file. The service default is CLEAN: empty demotion lists, no rename pairs,
 * no filler-word filtering beyond the generic BM25 stopwords, and no taxonomy
 * expansion. The runir tenant's profile (config/ranking-profiles.runir.json)
 * carries today's exact values, behavior-frozen.
 */

// ---------------------------------------------------------------------------
// Compiled (runtime) profile shape — what the 4 consumers read.
// ---------------------------------------------------------------------------

/** Compiled stale-signal demotion patterns keyed by intent label. */
export type StaleSignalMap = Readonly<Record<string, readonly RegExp[]>>;

/** Compiled known-rename contradiction pairs (older symbol, newer symbol). */
export type KnownRenamePairs = readonly (readonly [RegExp, RegExp])[];

/** A taxonomy expansion facet: query signals → expansion terms. */
export type TaxonomyExpansionFacet = {
  readonly signals: ReadonlySet<string>;
  readonly terms: readonly string[];
};

export interface RankingProfile {
  /** Intent → stale-signal demotion regexes. */
  readonly staleSignals: StaleSignalMap;
  /** Known-rename contradiction pairs. */
  readonly knownRenames: KnownRenamePairs;
  /** Entity-mention candidate words to exclude (beyond generic stopwords). */
  readonly entityFillerWords: ReadonlySet<string>;
  /** Taxonomy query-expansion facets. */
  readonly taxonomyExpansionFacets: readonly TaxonomyExpansionFacet[];
  /**
   * Minimum status_retrieved_count for a semiote to enter the LEARNED status-noise
   * set (Rúnir-mmg2.2). Membership = status_retrieved_count >= threshold AND
   * status_used_count == 0. `undefined` → use {@link DEFAULT_LEARNED_NOISE_THRESHOLD}.
   * R2: this is a PLACEHOLDER default tunable per-tenant via the profile; tuning
   * against real data is a non-blocking later observation.
   */
  readonly learnedNoiseThreshold?: number;
  /**
   * Semiote ids that must NEVER be demoted by the LEARNED set (Rúnir-mmg2.2). An
   * id here is EXCLUDED from the learned-noise membership even if its counters
   * cross the threshold — an operator escape hatch for a memory the learner is
   * wrongly demoting. Does not affect the static staleSignals-regex demotion.
   */
  readonly neverDemotePins: ReadonlySet<string>;
}

/**
 * Default status-retrieved threshold for learned-noise membership (Rúnir-mmg2.2
 * R2). A semiote shown under a status/opener recall at least this many times and
 * never lexically used in any of those answers is treated as learned status
 * noise. PLACEHOLDER value — overridable per-tenant via the ranking profile's
 * `learnedNoiseThreshold`; tuning is a non-blocking follow-up observation.
 */
export const DEFAULT_LEARNED_NOISE_THRESHOLD = 5;

/**
 * The CLEAN service default: no tenant data baked into ranking. A fresh tenant
 * with no profile configured gets exactly this — generic mechanisms only.
 */
export const EMPTY_PROFILE: RankingProfile = {
  staleSignals: {},
  knownRenames: [],
  entityFillerWords: new Set<string>(),
  taxonomyExpansionFacets: [],
  learnedNoiseThreshold: undefined,
  neverDemotePins: new Set<string>(),
};

// ---------------------------------------------------------------------------
// Serialized (on-disk JSON) schema — zod-validated.
// ---------------------------------------------------------------------------

/** A RegExp serialized as {pattern, flags}; refined by test-compiling it. */
const serializedRegexSchema = z
  .object({
    pattern: z.string(),
    flags: z.string().default(""),
  })
  .refine(
    (r) => {
      try {
        new RegExp(r.pattern, r.flags);
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid regex pattern/flags" },
  );

const taxonomyFacetSchema = z.object({
  signals: z.array(z.string()),
  terms: z.array(z.string()),
});

const profileEntrySchema = z.object({
  userId: z.string().min(1),
  staleSignals: z.record(z.string(), z.array(serializedRegexSchema)).default({}),
  knownRenames: z.array(z.tuple([serializedRegexSchema, serializedRegexSchema])).default([]),
  entityFillerWords: z.array(z.string()).default([]),
  taxonomyExpansionFacets: z.array(taxonomyFacetSchema).default([]),
  // Rúnir-mmg2.2: learned status-noise tuning (both optional; absent → defaults).
  learnedNoiseThreshold: z.number().int().positive().optional(),
  neverDemotePins: z.array(z.string()).default([]),
});

const rankingProfilesFileSchema = z.object({
  profiles: z.array(profileEntrySchema),
});

export type SerializedRankingProfileEntry = z.infer<typeof profileEntrySchema>;

// ---------------------------------------------------------------------------
// Compile: serialized → runtime.
// ---------------------------------------------------------------------------

function compileRegex(r: { pattern: string; flags: string }): RegExp {
  return new RegExp(r.pattern, r.flags);
}

function compileProfile(entry: SerializedRankingProfileEntry): RankingProfile {
  const staleSignals: Record<string, readonly RegExp[]> = {};
  for (const [intent, regexes] of Object.entries(entry.staleSignals)) {
    staleSignals[intent] = regexes.map(compileRegex);
  }
  const knownRenames: (readonly [RegExp, RegExp])[] = entry.knownRenames.map(
    ([a, b]) => [compileRegex(a), compileRegex(b)] as const,
  );
  const taxonomyExpansionFacets: TaxonomyExpansionFacet[] = entry.taxonomyExpansionFacets.map(
    (facet) => ({
      signals: new Set(facet.signals),
      terms: facet.terms,
    }),
  );
  return {
    staleSignals,
    knownRenames,
    entityFillerWords: new Set(entry.entityFillerWords),
    taxonomyExpansionFacets,
    learnedNoiseThreshold: entry.learnedNoiseThreshold,
    neverDemotePins: new Set(entry.neverDemotePins),
  };
}

// ---------------------------------------------------------------------------
// Load + resolve (module-level cache, populated once at startup).
// ---------------------------------------------------------------------------

let profileCache: Map<string, RankingProfile> | null = null;

/** Parses a raw JSON value into a userId → compiled-profile map. Throws on
 *  schema/regex-compile failure (fail loud at startup, never silently corrupt). */
export function parseRankingProfiles(value: unknown): Map<string, RankingProfile> {
  const parsed = rankingProfilesFileSchema.parse(value);
  const map = new Map<string, RankingProfile>();
  for (const entry of parsed.profiles) {
    map.set(entry.userId, compileProfile(entry));
  }
  return map;
}

/**
 * Loads ranking profiles once from a JSON file path. Call at startup.
 *
 * Failure semantics (the operator's intent is authoritative):
 *   - Path UNSET/empty → no profiles loaded, quiet. Every tenant gets
 *     {@link EMPTY_PROFILE} (clean defaults only).
 *   - Path SET but the file is missing/unreadable/schema-invalid → THROW, so
 *     bootstrap refuses to start. An operator who sets RUNIR_RANKING_PROFILES has
 *     declared intent; silently falling back to clean defaults would drop a
 *     tenant's demotion/expansion behavior unnoticed (fail loud, never silently
 *     corrupt — matching {@link parseRankingProfiles}).
 *
 * @param path  Profiles file path. Defaults to `process.env.RUNIR_RANKING_PROFILES`.
 */
export function loadRankingProfiles(
  path: string | undefined = process.env.RUNIR_RANKING_PROFILES,
): Map<string, RankingProfile> {
  if (!path) {
    profileCache = new Map();
    return profileCache;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  profileCache = parseRankingProfiles(raw);
  return profileCache;
}

/**
 * Resolves the active ranking profile for a userId. Lazily loads from the
 * default env path on first call if {@link loadRankingProfiles} was never run.
 * Unknown tenants (and the no-profile-configured case) get {@link EMPTY_PROFILE}.
 */
export function resolveRankingProfile(userId: string): RankingProfile {
  if (profileCache === null) {
    loadRankingProfiles();
  }
  return profileCache?.get(userId) ?? EMPTY_PROFILE;
}

/** Test-only: reset the module-level cache so a fresh load can be observed. */
export function resetRankingProfileCacheForTests(): void {
  profileCache = null;
}

// ---------------------------------------------------------------------------
// Learned status-noise profile (Rúnir-mmg2.2) — derived view + TTL cache.
// ---------------------------------------------------------------------------

/**
 * The learned status-noise membership for one tenant: a set of semiote ids that
 * crossed the status-retrieved threshold without ever being lexically used in a
 * status-intent answer, MINUS the profile's never-demote pins.
 */
export interface LearnedNoiseProfile {
  /** Effective learned-noise membership (pins already excluded). */
  readonly learnedNoiseIds: ReadonlySet<string>;
  /** The threshold that produced this set (resolved default or profile override). */
  readonly threshold: number;
}

const EMPTY_LEARNED_NOISE_PROFILE: LearnedNoiseProfile = {
  learnedNoiseIds: new Set<string>(),
  threshold: DEFAULT_LEARNED_NOISE_THRESHOLD,
};

/** TTL for the per-client learned-noise cache (ogkn.1 fingerprint-cache pattern). */
export const DEFAULT_LEARNED_NOISE_TTL_MS = 60_000;

/** Fetches the raw learned-noise ids for (userId, threshold) — the DB query seam. */
export type LearnedNoiseFetcher = (userId: string, threshold: number) => Promise<string[]>;

type LearnedNoiseCacheEntry = { profile: LearnedNoiseProfile; expiresAt: number };
// Keyed by the client/connection OBJECT (WeakMap), then by userId — matches the
// ogkn.1 fingerprint cache so admin override-clients never poison each other and
// the entry is GC'd with its client.
const _learnedNoiseCache = new WeakMap<object, Map<string, LearnedNoiseCacheEntry>>();

/**
 * Resolves the LEARNED status-noise profile for a tenant (Rúnir-mmg2.2),
 * TTL-cached per (clientKey, userId).
 *
 * Membership = status_retrieved_count >= threshold AND status_used_count == 0
 * (computed in the injected fetcher / DB query), MINUS the ranking profile's
 * `neverDemotePins`. The threshold is the profile's `learnedNoiseThreshold` or
 * {@link DEFAULT_LEARNED_NOISE_THRESHOLD}.
 *
 * A FRESH tenant (no status-intent feedback accrued) yields an EMPTY set — the
 * fetcher's `>=` predicate never matches NULL counters — so the demotion-site
 * union is a provable no-op at landing (R4).
 *
 * The fetcher is dependency-injected (not a hard import of phase2-store) so this
 * module stays decoupled and the view is trivially unit-testable.
 *
 * @param clientKey  The SurrealClient instance (cache partition key).
 * @param userId     Tenant id.
 * @param profile    Resolved ranking profile (threshold override + pins).
 * @param fetch      DB-query seam returning the raw matching ids.
 * @param nowMs      Injectable clock for tests.
 */
export async function getLearnedNoiseProfile(
  clientKey: object,
  userId: string,
  profile: RankingProfile,
  fetch: LearnedNoiseFetcher,
  nowMs: number = Date.now(),
): Promise<LearnedNoiseProfile> {
  const threshold = profile.learnedNoiseThreshold ?? DEFAULT_LEARNED_NOISE_THRESHOLD;

  let byUser = _learnedNoiseCache.get(clientKey);
  const cached = byUser?.get(userId);
  // Cache validity is keyed on the threshold too: a profile reload that changes
  // the threshold must not serve a set computed against the old one.
  if (cached && nowMs < cached.expiresAt && cached.profile.threshold === threshold) {
    return cached.profile;
  }

  let ids: string[];
  try {
    ids = await fetch(userId, threshold);
  } catch (err) {
    // Never let a learned-noise lookup failure break recall — degrade to the
    // empty set (static staleSignals demotion still applies). Warn-log only.
    console.warn("runir-recall: getLearnedNoiseProfile fetch failed, degrading to empty:", err);
    return { ...EMPTY_LEARNED_NOISE_PROFILE, threshold };
  }

  const pins = profile.neverDemotePins;
  const learnedNoiseIds = new Set<string>(
    pins.size === 0 ? ids : ids.filter((id) => !pins.has(id)),
  );
  const resolved: LearnedNoiseProfile = { learnedNoiseIds, threshold };

  if (!byUser) {
    byUser = new Map();
    _learnedNoiseCache.set(clientKey, byUser);
  }
  byUser.set(userId, { profile: resolved, expiresAt: nowMs + DEFAULT_LEARNED_NOISE_TTL_MS });
  return resolved;
}

/** Test-only: clear the learned-noise cache for a client key. */
export function resetLearnedNoiseCacheForTests(clientKey: object): void {
  _learnedNoiseCache.delete(clientKey);
}
