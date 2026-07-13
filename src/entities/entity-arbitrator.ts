import { SurrealClient, extractId } from "../storage/surreal/surreal-store.js";
import type { EntityMention, EntityRecord, MemoryScope } from "../domain/memory/types.js";
import { findEntityByName, findEntityByAlias, upsertEntity } from "./entity-store.js";

export type EntityArbitrationOutcome = "create" | "update" | "merge";

export type EntityArbitrationResult = {
  outcome: EntityArbitrationOutcome;
  entityId: string;
  reason: string;
};

/**
 * Unicode-safe entity name normalizer.
 * Preserves all Unicode letters and numbers (Cyrillic, Arabic, CJK, etc.)
 * while stripping combining marks (accents) for comparison.
 *
 * NOTE: This is NOT for SurrealDB record IDs — use entityIdSlug() for that.
 */
export function normalizeEntityName(name: string): string {
  return name
    .normalize("NFD")                            // Decompose Unicode
    .replace(/\p{M}/gu, "")                      // Strip combining marks (accents)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")           // Keep Unicode letters, digits, spaces, hyphens
    .replace(/\s+/g, " ")                         // Collapse whitespace
    .trim();
}

/**
 * ASCII-safe slug for SurrealDB record IDs.
 * Transliterates or hex-encodes non-ASCII characters.
 * Separate from normalizeEntityName() — this is ONLY for record ID derivation.
 *
 * Session-scoped stubs include scope + sessionId in the ID so they don't collide
 * with user-scoped canonicals or stubs from other sessions.
 * User-scoped canonicals omit scope/sessionId for backward compatibility.
 */
export function entityIdSlug(nameNorm: string, kind: string, userId: string, scope: string, sessionId?: string): string {
  const safe = (s: string) =>
    s.replace(/[^a-z0-9]/g, (ch) => {
      const code = ch.codePointAt(0);
      return code !== undefined ? `_x${code.toString(16)}_` : "_";
    })
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  // User-scoped canonicals: keyed by (userId, nameNorm, kind) only
  if (scope === "user") {
    return `${safe(nameNorm)}_${safe(kind)}_${safe(userId)}`;
  }
  // Session-scoped stubs: keyed by (userId, nameNorm, kind, scope, sessionId)
  return `${safe(nameNorm)}_${safe(kind)}_${safe(userId)}_${safe(scope)}_${safe(sessionId ?? "unknown")}`;
}

/** Strip id/createdAt/updatedAt from an EntityRecord for upsert. */
function stripMeta(rec: EntityRecord): Omit<EntityRecord, "id" | "createdAt" | "updatedAt"> {
  const { id: _id, createdAt: _ca, updatedAt: _ua, ...rest } = rec;
  return rest;
}

/**
 * Entity arbitration decision tree.
 *
 * Resolves an EntityMention against existing entities:
 *   1. User-scope canonical by name → update
 *   2. User-scope canonical by alias → merge
 *   3. Session-scope stub (same session) → update
 *   4. Create new session stub
 *
 * Does NOT promote scope from "session" to "user" — that is consolidation's job.
 */
export async function arbitrateEntity(
  db: SurrealClient,
  mention: EntityMention,
  userId: string,
  scope: MemoryScope,
  sessionId: string | undefined,
  sourceProject: string,
): Promise<EntityArbitrationResult> {
  // STEP 1: normalise
  const nameNorm = normalizeEntityName(mention.name);

  // STEP 2: user-scope canonical by name
  const results = await findEntityByName(db, nameNorm, mention.kind, userId, "user");
  if (results.length > 0) {
    const existing = results[0];
    const now = new Date().toISOString();
    const newAliases = (mention.aliases ?? []).map((a) => normalizeEntityName(a));
    const extraAlias = mention.name !== existing.canonicalName ? [mention.name] : [];
    const extraAliasNorm = mention.name !== existing.canonicalName ? [nameNorm] : [];

    await upsertEntity(db, {
      ...stripMeta(existing),
      lastSeenAt: now,
      confidence: Math.max(
        Number.isFinite(existing.confidence) ? existing.confidence : 0.5,
        Number.isFinite(mention.confidence) ? mention.confidence : 0.5,
      ),
      aliases: [...new Set([...(existing.aliases ?? []), ...(mention.aliases ?? []), ...extraAlias])],
      aliasesNorm: [...new Set([...(existing.aliasesNorm ?? []), ...newAliases, ...extraAliasNorm])],
      scope: existing.scope,
      sessionId: existing.sessionId,
      handles: mention.handles ?? existing.handles,
      orgType: mention.orgType ?? existing.orgType,
      subtype: mention.subtype ?? existing.subtype,
      description: mention.description ?? existing.description,
    });
    return { outcome: "update", entityId: extractId(existing.id), reason: "user canonical name match" };
  }

  // STEP 3: user-scope canonical by alias
  const aliasResults = await findEntityByAlias(db, nameNorm, userId, "user");
  const filtered = aliasResults.filter((e) => e.kind === mention.kind);
  if (filtered.length > 0) {
    const existing = filtered[0];
    const now = new Date().toISOString();

    let newCanonicalName = existing.canonicalName;
    let newNameNorm = existing.nameNorm;
    let extraAliases: string[] = [];
    let extraAliasesNorm: string[] = [];
    if ((Number.isFinite(mention.confidence) ? mention.confidence : 0.5) >
        (Number.isFinite(existing.confidence) ? existing.confidence : 0.5)) {
      newCanonicalName = mention.name;
      newNameNorm = nameNorm;
      extraAliases = [existing.canonicalName];
      extraAliasesNorm = [existing.nameNorm];
    }

    const allAliases = [...new Set([
      ...(existing.aliases ?? []),
      ...(mention.aliases ?? []),
      ...extraAliases,
      mention.name,
    ])];
    const allAliasesNorm = [...new Set([
      ...(existing.aliasesNorm ?? []),
      ...(mention.aliases ?? []).map((a) => normalizeEntityName(a)),
      ...extraAliasesNorm,
      nameNorm,
    ])];

    await upsertEntity(db, {
      ...stripMeta(existing),
      canonicalName: newCanonicalName,
      nameNorm: newNameNorm,
      lastSeenAt: now,
      confidence: Math.max(
        Number.isFinite(existing.confidence) ? existing.confidence : 0.5,
        Number.isFinite(mention.confidence) ? mention.confidence : 0.5,
      ),
      aliases: allAliases,
      aliasesNorm: allAliasesNorm,
      scope: existing.scope,
      sessionId: existing.sessionId,
      description: mention.description ?? existing.description,
    });
    return { outcome: "merge", entityId: extractId(existing.id), reason: "user canonical alias match" };
  }

  // STEP 4: session-scope stub (same session)
  if (sessionId !== undefined) {
    const sessionResults = await findEntityByName(db, nameNorm, mention.kind, userId, "session");
    const stub = sessionResults.find((e) => e.sessionId === sessionId);
    if (stub) {
      const now = new Date().toISOString();
      await upsertEntity(db, {
        ...stripMeta(stub),
        lastSeenAt: now,
        confidence: Math.max(
          Number.isFinite(stub.confidence) ? stub.confidence : 0.5,
          Number.isFinite(mention.confidence) ? mention.confidence : 0.5,
        ),
        aliases: [...new Set([...(stub.aliases ?? []), ...(mention.aliases ?? [])])],
        aliasesNorm: [...new Set([...(stub.aliasesNorm ?? []), ...(mention.aliases ?? []).map((a) => normalizeEntityName(a))])],
        description: mention.description ?? stub.description,
      });
      return { outcome: "update", entityId: extractId(stub.id), reason: "session stub name match" };
    }
  }

  // STEP 5: create new session stub
  const now = new Date().toISOString();
  const recordId = await upsertEntity(db, {
    kind: mention.kind,
    canonicalName: mention.name,
    nameNorm,
    aliases: mention.aliases ?? [],
    aliasesNorm: (mention.aliases ?? []).map((a) => normalizeEntityName(a)),
    description: mention.description,
    confidence: mention.confidence,
    sourceProject,
    firstSeenAt: now,
    lastSeenAt: now,
    scope: "session",
    sessionId,
    userId,
    handles: mention.handles,
    orgType: mention.orgType,
    subtype: mention.subtype,
  });
  return { outcome: "create", entityId: recordId, reason: "new session stub created" };
}
