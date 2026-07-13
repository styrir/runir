import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage/surreal/phase2-store.js", () => ({
  getRetrievalFootprintFromTrace: vi.fn().mockResolvedValue(null),
  retrievalFootprintIdentityMatches: vi.fn().mockReturnValue(true),
  toRetrievalFootprintIdentitySnapshot: vi.fn().mockImplementation((identity: any) => ({
    userId: identity.userId,
    contextScopeKind: identity.contextScopeKind,
    sessionId: identity.raw.sessionId,
    projectKey: identity.projectKey,
    agentId: identity.agentId,
    resolvedTaskId: identity.resolvedTaskId,
    path: identity.raw.path,
    derivation: identity.derivation,
  })),
}));

vi.mock("../storage/surreal/surreal-store.js", () => ({
  getProjectStateForCaptureContext: vi.fn().mockResolvedValue(null),
  listRecentFactsForCaptureContext: vi.fn().mockResolvedValue([]),
  listNearbyExistingForCaptureContext: vi.fn().mockResolvedValue([]),
}));

import { buildCaptureContextPacket } from "../capture/capture-context-assembler.js";
import { getRetrievalFootprintFromTrace, retrievalFootprintIdentityMatches } from "../storage/surreal/phase2-store.js";
import { getProjectStateForCaptureContext, listNearbyExistingForCaptureContext, listRecentFactsForCaptureContext } from "../storage/surreal/surreal-store.js";

const identity = {
  userId: "u1",
  contextScopeKind: "session",
  projectKey: "project:runir",
  raw: { sessionId: "sess-1", path: "/repo" },
  derivation: {
    contextScopeKind: { value: "session", source: "sessionId" },
    agentId: { source: "absent" },
    resolvedTaskId: { source: "absent" },
    projectKey: { value: "project:runir", source: "projectId" },
  },
} as any;

describe("capture-context-assembler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listRecentFactsForCaptureContext as any).mockResolvedValue([]);
    (listNearbyExistingForCaptureContext as any).mockResolvedValue([]);
    (getProjectStateForCaptureContext as any).mockResolvedValue(null);
    (getRetrievalFootprintFromTrace as any).mockResolvedValue(null);
    (retrievalFootprintIdentityMatches as any).mockReturnValue(true);
  });

  it("builds a deterministic empty packet when no trace or state is present", async () => {
    const packet = await buildCaptureContextPacket({ db: {} as any, userId: "u1", identity });

    expect(packet.retrieval_footprint).toBeNull();
    expect(packet.relation_hints).toEqual([]);
    expect(packet.debug.slotCounts).toEqual({
      recentFacts: 0,
      shownMemoryIds: 0,
      nearbyExisting: 0,
      relationHints: 0,
    });
    expect(packet.debug.stateAnchorState).toBe("omitted");
    expect(packet.debug.identityMatchedFootprint).toBeNull();
  });

  it("marks state_anchor as stale when project state is old", async () => {
    (getProjectStateForCaptureContext as any).mockResolvedValue({
      id: "ps-1",
      currentFocus: "working on recall",
      latestProgress: "wired capture context",
      blockers: [],
      nextSteps: ["add tests"],
      updatedAt: "2026-04-10T00:00:00.000Z",
      confidence: 0.8,
    });

    const packet = await buildCaptureContextPacket({ db: {} as any, userId: "u1", identity });

    expect(packet.state_anchor).toEqual(expect.objectContaining({
      projectStateId: "ps-1",
      freshness: "stale",
    }));
    expect(packet.debug.stateAnchorState).toBe("stale");
  });

  it("drops the retrieval footprint when identity mismatches", async () => {
    (getRetrievalFootprintFromTrace as any).mockResolvedValue({
      traceId: "trace-1",
      identity: { userId: "u1", contextScopeKind: "project", derivation: identity.derivation },
      shownMemoryIds: ["semiote:m1"],
      selectedMemoryIds: ["semiote:m1"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "fact",
    });
    (retrievalFootprintIdentityMatches as any).mockReturnValue(false);

    const packet = await buildCaptureContextPacket({
      db: {} as any,
      userId: "u1",
      identity,
      retrievalTraceId: "trace-1",
    });

    expect(packet.retrieval_footprint).toBeNull();
    expect(packet.debug.identityMatchedFootprint).toBe(false);
  });
});
