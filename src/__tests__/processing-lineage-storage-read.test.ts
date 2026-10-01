import { describe, expect, it, vi } from "vitest";
import {
  attachSearchHitLineage,
  attachSelectedSearchHitLineage,
  getSearchHitLineage,
} from "../domain/memory/search-hit-lineage.js";
import {
  PROCESSING_LINEAGE_VERSION,
  classifyProcessingLineage,
} from "../domain/memory/processing-lineage.js";
import { mapMemoryRowToSearchHit } from "../storage/surreal/surreal-client.js";
import {
  findSimilarMemories,
  getMemoryById,
  hydrateLatestStateRepresentativeHits,
  listMemories,
  listNearbyExistingForCaptureContext,
  listRecentFactsForCaptureContext,
  listRecentMemories,
} from "../storage/surreal/memory-crud-store.js";
import { listContinuityMemoryHits } from "../storage/surreal/project-state-store.js";

const VALID_LINEAGE = {
  state: "minni_verified",
  origin: "minni",
  producer_principal_ref: "principal.sourcec.r1",
  producer_registration_ref: "registration.sourcec.r1",
  processing_policy_version: "runir.minni.local/v1",
  admitted_operation: "capture_ingest",
  target_user_id: "user.sourcec.r1",
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "ordinary",
    restrictions: [],
  },
} as const;

const RESTRICTED_LINEAGE = {
  ...VALID_LINEAGE,
  delivery: {
    version: PROCESSING_LINEAGE_VERSION,
    disposition: "local_only",
    restrictions: ["audio_derived", "excluded_source", "producer_local_only"],
  },
} as const;

const INVALID_LINEAGE = { ...VALID_LINEAGE, state: "forged" };

function row(id: string, processingLineage?: unknown) {
  return {
    id,
    payload: {
      l2: `synthetic ${id}`,
      userId: "user.sourcec.r1",
      path: "/synthetic/sourcec-r1",
      memoryRole: "current_status",
      tags: ["synthetic"],
      client: "spoof-client",
      source: "spoof-source",
      processing_lineage: VALID_LINEAGE,
    },
    ...(processingLineage === undefined ? {} : { processing_lineage: processingLineage }),
    created_at: "2026-10-01T21:00:00.000Z",
    updated_at: "2026-10-01T21:00:00.000Z",
    active: true,
    inactive_reason: undefined,
    superseded_by: undefined,
    lineage_root_id: id,
    valid_at: "2026-10-01T21:00:00.000Z",
    invalid_at: undefined,
    scope: "user",
    session_id: undefined,
    memory_role: "current_status",
    sim: 0.9,
  };
}

function dbFor(rows: unknown[]) {
  return { query: vi.fn().mockResolvedValue([rows]) } as any;
}

describe("storage lineage classification carrier", () => {
  it("keeps valid, restricted, legacy, invalid, and unavailable states distinct", () => {
    expect(classifyProcessingLineage(VALID_LINEAGE)).toMatchObject({ state: "minni_verified" });
    expect(classifyProcessingLineage(RESTRICTED_LINEAGE)).toMatchObject({ state: "minni_verified" });
    expect(classifyProcessingLineage(undefined)).toEqual({ state: "legacy_unknown" });
    expect(classifyProcessingLineage(null)).toMatchObject({ state: "invalid", reason: "null_value" });
    expect(classifyProcessingLineage({ ...VALID_LINEAGE, extra: true })).toMatchObject({ state: "invalid", reason: "unknown_root_field" });
    expect(classifyProcessingLineage({ ...VALID_LINEAGE, processing_policy_version: "runir.minni.local/v2" })).toMatchObject({ state: "invalid", reason: "policy_version" });
    expect(classifyProcessingLineage({ ...VALID_LINEAGE, delivery: { ...VALID_LINEAGE.delivery, version: "runir.minni.delivery/v2" } })).toMatchObject({ state: "invalid", reason: "delivery_version" });
    expect(classifyProcessingLineage({ ...VALID_LINEAGE, delivery: { ...VALID_LINEAGE.delivery, restrictions: ["future"] } })).toMatchObject({ state: "invalid", reason: "unknown_restriction" });

    const manual = { id: "manual", text: "minni_verified", client: "minni" };
    expect(getSearchHitLineage(manual)).toEqual({ state: "unavailable" });
  });

  it("uses only the selected top-level field and omits the carrier from JSON", () => {
    const unselected = mapMemoryRowToSearchHit(row("valid", VALID_LINEAGE));
    expect(getSearchHitLineage(unselected)).toEqual({ state: "unavailable" });

    const hit = attachSelectedSearchHitLineage(unselected, VALID_LINEAGE);
    expect(getSearchHitLineage(hit)).toMatchObject({ state: "minni_verified" });

    const spoofed = mapMemoryRowToSearchHit(row("spoof"));
    expect(getSearchHitLineage(spoofed)).toEqual({ state: "unavailable" });

    const selectedAbsence = attachSelectedSearchHitLineage(
      mapMemoryRowToSearchHit(row("legacy")),
      undefined,
    );
    expect(getSearchHitLineage(selectedAbsence)).toEqual({ state: "legacy_unknown" });

    const json = JSON.stringify(hit);
    expect(json).not.toContain("processing_lineage");
    expect(json).not.toContain("minni_verified");
    expect(getSearchHitLineage({ ...hit })).toMatchObject({ state: "minni_verified" });
  });

  it("attaches classification to each memory list/get/recent projection", async () => {
    const rows = [row("valid", VALID_LINEAGE), row("restricted", RESTRICTED_LINEAGE), row("invalid", INVALID_LINEAGE), row("legacy")];
    for (const [name, read] of [
      ["list", (db: any) => listMemories(db, "user.sourcec.r1", undefined, "semiote")],
      ["get", (db: any) => getMemoryById(db, "valid", "user.sourcec.r1", "semiote")],
      ["recent", (db: any) => listRecentMemories(db, "user.sourcec.r1", "2026-10-01T00:00:00.000Z", 10, undefined, "semiote")],
    ] as const) {
      const db = dbFor(name === "get" ? [rows[0]] : rows);
      const result = await read(db);
      expect(result.length).toBeGreaterThan(0);
      expect(getSearchHitLineage(result[0])).toMatchObject({ state: "minni_verified" });
      expect(result[0]).not.toHaveProperty("processing_lineage");
      expect(db.query.mock.calls[0][0]).toContain("processing_lineage");
    }
  });

  it("classifies capture, similar, latest-state, and continuity projections", async () => {
    const captureIdentity = { contextScopeKind: "project", raw: { path: "/synthetic/sourcec-r1" } } as any;
    const allRows = [row("valid", VALID_LINEAGE), row("invalid", INVALID_LINEAGE), row("legacy")];

    const captureDb = dbFor(allRows);
    const recentFacts = await listRecentFactsForCaptureContext(captureDb, "user.sourcec.r1", captureIdentity);
    const nearby = await listNearbyExistingForCaptureContext(captureDb, "user.sourcec.r1", captureIdentity);
    expect(getSearchHitLineage(recentFacts[0])).toMatchObject({ state: "minni_verified" });
    expect(getSearchHitLineage(nearby[1])).toMatchObject({ state: "invalid" });
    expect(captureDb.query.mock.calls[0][0]).toContain("processing_lineage");

    const similarDb = dbFor([row("legacy")]);
    const similar = await findSimilarMemories(similarDb, "user.sourcec.r1", [1, 0, 0], 24, 5);
    expect(getSearchHitLineage(similar[0])).toEqual({ state: "legacy_unknown" });
    expect(similarDb.query.mock.calls[0][0]).toContain("processing_lineage = NONE");
    expect(similarDb.query.mock.calls[0][0]).toContain("SELECT id, payload, processing_lineage");

    const latestDb = dbFor(allRows);
    const latest = await hydrateLatestStateRepresentativeHits(latestDb, "user.sourcec.r1", {
      continuitySubjectKeys: ["subject.sourcec.r1"],
    });
    expect(getSearchHitLineage(latest[1])).toMatchObject({ state: "invalid" });

    const continuityDb = dbFor(allRows);
    const continuity = await listContinuityMemoryHits(continuityDb, "user.sourcec.r1", { path: "/synthetic/sourcec-r1" });
    expect(getSearchHitLineage(continuity[0])).toMatchObject({ state: "minni_verified" });
    expect(continuityDb.query.mock.calls[0][0]).toContain("processing_lineage");
  });

  it("does not classify from payload aliases, tags, client, source, or text", () => {
    const hit = mapMemoryRowToSearchHit({
      id: "payload-spoof",
      payload: {
        l2: "minni_verified",
        userId: "user.sourcec.r1",
        processing_lineage: VALID_LINEAGE,
        tags: ["minni_verified"],
        client: "minni",
        source: "minni",
      },
    });
    expect(getSearchHitLineage(hit)).toEqual({ state: "unavailable" });
    expect(getSearchHitLineage(attachSearchHitLineage({ id: "unselected" }))).toEqual({ state: "unavailable" });
    expect(getSearchHitLineage(attachSelectedSearchHitLineage({ id: "invalid" }, INVALID_LINEAGE))).toMatchObject({ state: "invalid" });
  });
});
