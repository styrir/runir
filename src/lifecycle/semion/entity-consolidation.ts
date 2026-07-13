import type { SurrealClient } from "../../storage/surreal/surreal-store.js";
import { composeEdgeReassignment, composeUpsertEntity, findEntityByName, mergeEntities } from "../../entities/entity-store.js";
import { entityIdSlug } from "../../entities/entity-arbitrator.js";

function normalizeEntityId(rawId: unknown): string {
  if (typeof rawId === "object" && rawId !== null && "id" in rawId) {
    return String((rawId as { id: unknown }).id);
  }
  return String(rawId ?? "");
}

export async function promoteSessionEntities(
  db: SurrealClient,
  userId: string,
  logger?: (msg: string) => void,
): Promise<{ promoted: number; merged: number; failed: number }> {
  let promoted = 0;
  let merged = 0;
  let failed = 0;

  // 1. Query all session-scoped entity stubs for userId
  const stubs =
    ((await db.query("SELECT * FROM entities WHERE userId = $userId AND scope = 'session'", { userId }))[0] as any[]) ??
    [];

  // 2. For each stub, check for existing user-scoped canonical
  for (const stub of stubs) {
    try {
      const canonicals = await findEntityByName(db, stub.nameNorm, stub.kind, userId, "user");

      if (canonicals.length > 0) {
        // b. Canonical found — merge (already ONE atomic transaction, shipped #4.2)
        const canonical = canonicals[0];

        let winnerUpdates: any = {};
        // Belt-and-braces NaN guards: legacy/foreign rows reaching this path with
        // non-numeric confidence must not corrupt winner selection via NaN comparisons
        // (NaN > x and NaN < x are both false, silently skewing the result).
        // Note: ?? only catches null/undefined, NOT NaN — use Number.isFinite.
        const stubConf = Number.isFinite(stub.confidence) ? stub.confidence : 0.5;
        const canonConf = Number.isFinite(canonical.confidence) ? canonical.confidence : 0.5;
        if (stubConf > canonConf) {
          // stub wins canonical name — displace canonical's name to aliases
          winnerUpdates = {
            canonicalName: stub.canonicalName,
            nameNorm: stub.nameNorm,
            aliases: [...new Set([...(canonical.aliases ?? []), canonical.canonicalName, ...(stub.aliases ?? [])])],
            aliasesNorm: [...new Set([...(canonical.aliasesNorm ?? []), canonical.nameNorm, ...(stub.aliasesNorm ?? [])])],
            confidence: stubConf,
            firstSeenAt: stub.firstSeenAt < canonical.firstSeenAt ? stub.firstSeenAt : canonical.firstSeenAt,
            lastSeenAt: stub.lastSeenAt > canonical.lastSeenAt ? stub.lastSeenAt : canonical.lastSeenAt,
          };
        } else {
          winnerUpdates = {
            aliases: [...new Set([...(canonical.aliases ?? []), stub.canonicalName, ...(stub.aliases ?? [])])],
            aliasesNorm: [...new Set([...(canonical.aliasesNorm ?? []), stub.nameNorm, ...(stub.aliasesNorm ?? [])])],
            confidence: Math.max(canonConf, stubConf),
            firstSeenAt: stub.firstSeenAt < canonical.firstSeenAt ? stub.firstSeenAt : canonical.firstSeenAt,
            lastSeenAt: stub.lastSeenAt > canonical.lastSeenAt ? stub.lastSeenAt : canonical.lastSeenAt,
          };
        }

        await mergeEntities(db, canonical.id!, stub.id!, winnerUpdates);
        merged++;
      } else {
        // c. No canonical — promote via atomic transaction: upsert canonical +
        //    move edges + delete stub. A crash between any two steps previously
        //    left orphan stubs or dropped edges (the Rúnir-imaf.12 failure class).
        //    All three writes now run inside ONE queryTransaction so they either
        //    all commit or all roll back (Rúnir-n7ze.11).
        const stubId = normalizeEntityId(stub.id).replace("entities:", "");
        const canonicalId = entityIdSlug(stub.nameNorm, stub.kind, stub.userId, "user");

        // Build the upsert fragment ("pu_" prefix = promote-upsert).
        const { id: _id, createdAt: _ca, updatedAt: _ua, ...stubRest } = stub;
        const up = composeUpsertEntity(
          { ...stubRest, scope: "user", sessionId: undefined },
          "pu_",
        );

        // composeEdgeReassignment does its reads BEFORE BEGIN (see entity-store.ts
        // doc comment). Prefix "pe" = promote-edges. Returns empty body when there
        // are no edges to move (no-op fragment).
        const { body: edgeBody, vars: edgeVars } = await composeEdgeReassignment(
          db,
          stubId,
          canonicalId,
          "pe",
        );

        // Assemble: upsert canonical → move edges (if any) → delete stub.
        // Param prefixes "pu_" / "pe" / "pdel" must not collide — verified by
        // construction (each uses a distinct string prefix).
        const stmts = [up.statement];
        if (edgeBody) stmts.push(edgeBody);
        stmts.push("DELETE type::record('entities', $pdelStubId);");
        const vars = { ...up.vars, ...edgeVars, pdelStubId: stubId };

        await db.queryTransaction(stmts.join("\n"), vars);

        promoted++;
      }
    } catch (err) {
      const stubId = normalizeEntityId(stub.id);
      logger?.(`entity consolidation: stub ${stubId} failed: ${String(err).slice(0, 160)}`);
      failed++;
    }
  }

  logger?.(`memory-hybrid: entity consolidation: promoted=${promoted}, merged=${merged}, failed=${failed}`);
  return { promoted, merged, failed };
}
