import { describe, expect, it, vi } from "vitest";
import {
  buildSemioteProvenanceEnvelope,
  createRetrievalTrace,
  ensurePhase2Schema,
  getRetrievalFootprintFromTrace,
  getRetrievalTrace,
  initializeSemioteSemiosis,
  listRetrievalTraces,
  patchRetrievalTraceAnswer,
  patchRetrievalTraceCaptureReceipt,
  patchRetrievalTraceRating,
  patchSemioteUsefulness,
  patchSemioteProvenance,
  markSemiotesFoldedIntoProjectState,
  promoteSemioteToNoema,
  queryLearnedStatusNoiseIds,
  toRetrievalFootprintIdentitySnapshot,
  upsertSemioteRelation,
  validateSemioteRelationKind,
} from "../storage/surreal/phase2-store.js";

function mockDb() {
  return { query: vi.fn().mockResolvedValue([[]]) } as any;
}

describe("phase2-store semiosis + noema persistence", () => {
  it("defines retrieval_trace as schemaless so nested item objects can persist", async () => {
    const db = mockDb();

    await ensurePhase2Schema(db);

    expect(db.query).toHaveBeenCalledWith("DEFINE TABLE IF NOT EXISTS retrieval_trace SCHEMALESS;");
    expect(db.query).toHaveBeenCalledWith("DEFINE TABLE IF NOT EXISTS hexis SCHEMALESS;");
    expect(db.query).toHaveBeenCalledWith("DEFINE TABLE IF NOT EXISTS semiote_relations TYPE RELATION FROM semiote TO semiote SCHEMAFULL;");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE FIELD IF NOT EXISTS claim_key ON TABLE noema TYPE option<string>;"));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("DEFINE INDEX IF NOT EXISTS idx_noema_user_claim ON TABLE noema COLUMNS user_id, claim_key;"));
  });

  it("maps retrieval traces into retrieval-footprint views with canonical identity + shown ids", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-1",
        user_id: "u1",
        session_id: "sess-1",
        prompt: "what is current status",
        intent_label: "current_status",
        lane_label: "status",
        retrieval_path: "hybrid",
        requested_path: "/repo",
        footprint_kind: "turn",
        canonical_identity: {
          userId: "u1",
          contextScopeKind: "session",
          sessionId: "sess-1",
          projectKey: "project:runir",
          path: "/repo",
          derivation: {
            contextScopeKind: { value: "session", source: "sessionId" },
            agentId: { source: "absent" },
            resolvedTaskId: { source: "absent" },
            projectKey: { value: "project:runir", source: "projectId", marker: "explicit" },
          },
        },
        access_tracked_ids: ["semiote:m1"],
        items: [{ id: "semiote:m1", score: 0.9 }, { id: "semiote:m2", score: 0.8 }],
        created_at: "2026-04-16T07:00:00.000Z",
      },
    ]]);

    const footprint = await getRetrievalFootprintFromTrace(db, "trace-1", "u1");

    expect(footprint).toEqual({
      traceId: "trace-1",
      identity: expect.objectContaining({
        userId: "u1",
        contextScopeKind: "session",
        sessionId: "sess-1",
        projectKey: "project:runir",
        path: "/repo",
      }),
      shownMemoryIds: ["semiote:m1"],
      selectedMemoryIds: ["semiote:m1", "semiote:m2"],
      createdAt: "2026-04-16T07:00:00.000Z",
      retrievalPath: "hybrid",
      intentLabel: "current_status",
      sessionId: "sess-1",
      requestedPath: "/repo",
    });
  });

  it("serializes canonical identity snapshots for retrieval traces", () => {
    const snapshot = toRetrievalFootprintIdentitySnapshot({
      userId: "u1",
      contextScopeKind: "project",
      agentId: undefined,
      resolvedTaskId: "task-1",
      projectKey: "project:runir",
      raw: {
        path: "/repo",
        projectId: "runir",
      },
      derivation: {
        contextScopeKind: { value: "project", source: "projectId" },
        agentId: { source: "absent" },
        resolvedTaskId: { value: "task-1", source: "taskId" },
        projectKey: { value: "project:runir", source: "projectId", marker: "explicit" },
      },
    });

    expect(snapshot).toEqual({
      userId: "u1",
      contextScopeKind: "project",
      sessionId: undefined,
      projectKey: "project:runir",
      agentId: undefined,
      resolvedTaskId: "task-1",
      path: "/repo",
      derivation: {
        contextScopeKind: { value: "project", source: "projectId" },
        agentId: { source: "absent" },
        resolvedTaskId: { value: "task-1", source: "taskId" },
        projectKey: { value: "project:runir", source: "projectId", marker: "explicit" },
      },
    });
  });

  it("builds provenance envelopes from canonical identity + write context", () => {
    const envelope = buildSemioteProvenanceEnvelope({
      sourceKind: "capture",
      writeSource: "capture",
      retrievalTraceId: "trace-1",
      runirSessionId: "runir_session_123",
      nativeSessionId: "native-1",
      sessionId: "sess-1",
      path: "/repo",
      client: "claude-code",
      sourceHostId: "host-1",
      sourceEventId: "evt-1",
      sourceTurnIndex: 7,
      sourceCursorStart: 11,
      sourceCursorEnd: 19,
      extraction: {
        mode: "capture",
        model: "test-model",
        capturedAt: "2026-04-16T07:00:00.000Z",
      },
      identity: {
        userId: "u1",
        contextScopeKind: "project",
        projectKey: "project:runir",
        resolvedTaskId: "task-1",
        agentId: undefined,
        raw: {
          sessionId: "sess-1",
          path: "/repo",
        },
      } as any,
    });

    expect(envelope).toEqual({
      sourceKind: "capture",
      writeSource: "capture",
      retrievalTraceId: "trace-1",
      runirSessionId: "runir_session_123",
      nativeSessionId: "native-1",
      sessionId: "sess-1",
      path: "/repo",
      client: "claude-code",
      sourceHostId: "host-1",
      sourceEventId: "evt-1",
      sourceTurnIndex: 7,
      sourceCursorStart: 11,
      sourceCursorEnd: 19,
      extraction: {
        mode: "capture",
        model: "test-model",
        capturedAt: "2026-04-16T07:00:00.000Z",
      },
      derivation: {
        contextScopeKind: "project",
        projectKey: "project:runir",
        agentId: undefined,
        resolvedTaskId: "task-1",
      },
    });
  });

  it("writes provenance envelopes onto semiote rows and projects queryable top-level provenance fields", async () => {
    const db = mockDb();

    await patchSemioteProvenance(db, "semi-1", {
      sourceKind: "capture",
      writeSource: "capture",
      retrievalTraceId: "trace-1",
      runirSessionId: "runir_session_123",
      nativeSessionId: "native-1",
      sessionId: "sess-1",
      path: "/repo",
      client: "claude-code",
      sourceHostId: "host-1",
      sourceEventId: "evt-1",
      sourceTurnIndex: 7,
      sourceCursorStart: 11,
      sourceCursorEnd: 19,
      extraction: {
        mode: "capture",
        capturedAt: "2026-04-16T07:00:00.000Z",
      },
      derivation: {
        contextScopeKind: "session",
      },
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("runir_session_id = $runirSessionId"),
      expect.objectContaining({
        id: "semi-1",
        provenance: expect.objectContaining({
          sourceKind: "capture",
          retrievalTraceId: "trace-1",
        }),
        runirSessionId: "runir_session_123",
        nativeSessionId: "native-1",
        projectKey: undefined,
        sourceClient: "claude-code",
        sourceHostId: "host-1",
        sourceEventId: "evt-1",
        sourceTurnIndex: 7,
        sourceCursorStart: 11,
        sourceCursorEnd: 19,
      }),
    );
  });

  it("does not query when there are no folded semiote ids to mark", async () => {
    const db = mockDb();

    await markSemiotesFoldedIntoProjectState(db, [], "project_state:next", "2026-04-20T08:00:00.000Z");

    expect(db.query).not.toHaveBeenCalled();
  });

  it("marks exact semiote ids as folded into a project_state receipt", async () => {
    const db = mockDb();

    await markSemiotesFoldedIntoProjectState(db, ["semi-1", "semi-2"], "project_state:next", "2026-04-20T08:00:00.000Z");

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("folded_into_project_state_id = $projectStateId"),
      expect.objectContaining({
        ids: ["semi-1", "semi-2"],
        projectStateId: "project_state:next",
        foldedAt: "2026-04-20T08:00:00.000Z",
      }),
    );
  });

  it("accepts only the narrow semiote relation vocabulary", () => {
    expect(validateSemioteRelationKind("related_to")).toBe("related_to");
    expect(validateSemioteRelationKind("derived_from")).toBe("derived_from");
    expect(() => validateSemioteRelationKind("supports")).toThrow("Unsupported semiote relation kind");
  });

  it("creates semiote relations with capture-grounded metadata", async () => {
    const db = mockDb();
    db.query
      .mockResolvedValueOnce([[
        { id: "semiote:source-1", user_id: "u1", path: "/repo", payload: { userId: "u1", path: "/repo" } },
        { id: "semiote:dest-1", user_id: "u1", path: "/repo", payload: { userId: "u1", path: "/repo" } },
      ]])
      .mockResolvedValueOnce([[]]);

    await upsertSemioteRelation(db, {
      in: "dest-1",
      out: "source-1",
      kind: "derived_from",
      userId: "u1",
      scope: "user",
      sessionId: "sess-1",
      path: "/repo",
      retrievalTraceId: "trace-1",
      sourceWrite: "capture",
      provenance: "capture-grounded",
    });

    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("RELATE $fromRecord -> semiote_relations -> $toRecord SET"),
      expect.objectContaining({
        kind: "derived_from",
        userId: "u1",
        retrievalTraceId: "trace-1",
        provenance: "capture-grounded",
      }),
    );
  });

  it("rejects user-scoped relations when an endpoint is session-scoped", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[
      { id: "semiote:source-1", user_id: "u1", session_id: "sess-1", payload: { userId: "u1", sessionId: "sess-1" } },
      { id: "semiote:dest-1", user_id: "u1", payload: { userId: "u1" } },
    ]]);

    await expect(upsertSemioteRelation(db, {
      in: "dest-1",
      out: "source-1",
      kind: "derived_from",
      userId: "u1",
      scope: "user",
      sessionId: undefined,
      path: undefined,
      retrievalTraceId: "trace-1",
      sourceWrite: "capture",
      provenance: "capture-grounded",
    })).rejects.toThrow("session-scoped endpoints must use session scope");
  });

  it("writes semiosis snapshots onto semiote rows", async () => {
    const db = mockDb();

    await initializeSemioteSemiosis(db, "semi-1", {
      confidence: 0.9,
      usefulnessAlpha: 4,
      usefulnessBeta: 1,
      usefulnessScore: 0.8,
      contradictionCount: 0,
      retrievedCount: 2,
      lastEvaluatedAt: "2026-04-13T10:00:00.000Z",
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("payload.semiosis"),
      expect.objectContaining({
        id: "semi-1",
        semiosis: expect.objectContaining({
          extraction_confidence: 0.9,
          utility: 0.8,
          stability: 0.8,
          hexis_id: null,
          version: "phase2-v1",
        }),
      }),
    );
  });

  it("patchSemioteUsefulness updates semiosis alongside usefulness counters", async () => {
    const db = mockDb();

    await patchSemioteUsefulness(db, "semi-1", {
      usefulnessAlpha: 5,
      usefulnessBeta: 1,
      usefulnessScore: 0.83,
      retrievedCount: 4,
      usedCount: 4,
      successfulUseCount: 3,
      crossSessionUseCount: 2,
      contradictionCount: 0,
      hexisId: "hexis-1",
      hexisVersion: 2,
      hexisFit: 0.9,
      rankingExplanation: ["hexis:semantic=0.90"],
      lastRetrievedAt: "2026-04-13T10:00:00.000Z",
      lastUsedAt: "2026-04-13T10:00:00.000Z",
      lastEvaluatedAt: "2026-04-13T10:00:00.000Z",
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("semiosis = $semiosis"),
      expect.objectContaining({
        id: "semi-1",
        semiosis: expect.objectContaining({
          utility: 0.83,
          promotion_score: expect.any(Number),
          hexis_id: "hexis-1",
          hexis_version: 2,
          hexis_fit: 0.9,
        }),
      }),
    );
  });

  it("defines the status-noise counter fields + index in ensurePhase2Schema (mmg2.2)", async () => {
    const db = mockDb();
    await ensurePhase2Schema(db);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS status_retrieved_count ON TABLE semiote TYPE option<int>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS status_used_count ON TABLE semiote TYPE option<int>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE INDEX IF NOT EXISTS idx_semiote_user_status_counts ON TABLE semiote COLUMNS user_id, status_retrieved_count, status_used_count;"),
    );
  });

  it("patchSemioteUsefulness threads the status counters when supplied (mmg2.2)", async () => {
    const db = mockDb();
    await patchSemioteUsefulness(db, "semi-1", {
      usefulnessAlpha: 5,
      usefulnessBeta: 1,
      usefulnessScore: 0.83,
      retrievedCount: 4,
      usedCount: 0,
      successfulUseCount: 0,
      crossSessionUseCount: 0,
      contradictionCount: 0,
      statusRetrievedCount: 5,
      statusUsedCount: 0,
    });
    const [sql, params] = db.query.mock.calls.at(-1);
    expect(sql).toContain("status_retrieved_count = IF $statusRetrievedCount != NONE");
    expect(sql).toContain("status_used_count = IF $statusUsedCount != NONE");
    expect(params).toMatchObject({ statusRetrievedCount: 5, statusUsedCount: 0 });
  });

  it("queryLearnedStatusNoiseIds asks for >= threshold AND used==0 AND active, returns bare ids (mmg2.2)", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[{ id: "semiote:abc" }, { id: "semiote:def" }]]);
    const ids = await queryLearnedStatusNoiseIds(db, "owner", 5);
    expect(ids).toEqual(["abc", "def"]);
    const [sql, params] = db.query.mock.calls.at(-1);
    expect(sql).toContain("status_retrieved_count >= $threshold");
    expect(sql).toContain("status_used_count = 0");
    expect(sql).toContain("active = true");
    expect(params).toMatchObject({ userId: "owner", threshold: 5 });
  });

  it("promotes eligible semiote rows into deterministic noema records", async () => {
    const db = mockDb();
    const row = {
      id: "semiote:semi-1",
      user_id: "u1",
      scope: "user",
      path: "/repo/file.ts",
      memory_role: "current_status",
      embedding: [0.1, 0.2, 0.3],
      payload: {
        l2: "The capture hook writes semiote records directly.",
        l0: "Capture hook writes semiote",
        category: "cases",
        factKey: "cases:capture-hook-direct-write",
        continuitySubjectKey: "capture-hook",
        claimPredicate: "writes",
        confidence: 0.92,
      },
      usefulness_alpha: 5,
      usefulness_beta: 1,
      usefulness_score: 0.83,
      retrieved_count: 4,
      successful_use_count: 3,
      cross_session_use_count: 2,
      contradiction_count: 0,
    };

    const result = await promoteSemioteToNoema(db, row);

    expect(result.promoted).toBe(true);
    expect(result.id).toMatch(/^noema:[a-f0-9]{24}$/);
    expect(db.query).toHaveBeenNthCalledWith(
      1,
      "SELECT status FROM type::record('noema', $id) LIMIT 1;",
      expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]{24}$/),
      }),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPSERT type::record('noema', $id)"),
      expect.objectContaining({
        userId: "u1",
        supportSemioteIds: ["semi-1"],
        canonicalText: "The capture hook writes semiote records directly.",
        claimKey: expect.stringMatching(/^[a-f0-9]{32}$/),
        revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: "active",
        stableClaim: {
          subject: "capture-hook",
          predicate: "writes",
          value: "The capture hook writes semiote records directly.",
        },
      }),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE type::record('semiote', $id)"),
      expect.objectContaining({
        id: "semi-1",
        claimKey: expect.stringMatching(/^[a-f0-9]{32}$/),
        revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: "active",
        stableClaim: {
          subject: "capture-hook",
          predicate: "writes",
          value: "The capture hook writes semiote records directly.",
        },
      }),
    );
  });

  it("does not reactivate terminal noema statuses during promotion", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[{ status: "superseded" }]]);

    await promoteSemioteToNoema(db, {
      id: "semiote:semi-1",
      user_id: "u1",
      scope: "user",
      path: "/repo/file.ts",
      memory_role: "current_status",
      payload: {
        l2: "The capture hook writes semiote records directly.",
        l0: "Capture hook writes semiote",
        category: "cases",
        factKey: "cases:capture-hook-direct-write",
        continuitySubjectKey: "capture-hook",
        claimPredicate: "writes",
        noemaStatus: "active",
        confidence: 0.92,
      },
      usefulness_alpha: 5,
      usefulness_beta: 1,
      usefulness_score: 0.83,
      retrieved_count: 4,
      successful_use_count: 3,
      cross_session_use_count: 2,
      contradiction_count: 0,
    });

    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPSERT type::record('noema', $id)"),
      expect.objectContaining({
        status: "superseded",
      }),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE type::record('semiote', $id)"),
      expect.objectContaining({
        status: "superseded",
      }),
    );
  });

  it("does not promote semiote rows that lack enough cross-session evidence", async () => {
    const db = mockDb();
    const result = await promoteSemioteToNoema(db, {
      id: "semiote:semi-2",
      user_id: "u1",
      payload: { l2: "A tentative working-memory note.", confidence: 0.6 },
      usefulness_score: 0.7,
      successful_use_count: 1,
      cross_session_use_count: 0,
      contradiction_count: 0,
    });

    expect(result).toEqual({ promoted: false, id: null, embeddingWritten: false });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("retrieval_trace persistence augmentation (A′ step 1 — Memory Impact Viewer)", () => {
  it("defines the new prepend_context / answer / feedback fields on retrieval_trace", async () => {
    const db = mockDb();
    await ensurePhase2Schema(db);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS prepend_context ON TABLE retrieval_trace TYPE option<string>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS answer ON TABLE retrieval_trace TYPE option<string>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS response_resolution ON TABLE retrieval_trace TYPE option<string>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS corrected_ids ON TABLE retrieval_trace TYPE option<array<string>>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS feedback_received_at ON TABLE retrieval_trace TYPE option<datetime>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS capture_receipt ON TABLE retrieval_trace TYPE option<object>;"),
    );
  });

  it("createRetrievalTrace persists the verbatim prependContext but not the feedback-only fields", async () => {
    const db = mockDb();
    await createRetrievalTrace(db, {
      userId: "u1",
      prompt: "what is the current status",
      intentLabel: "current_status",
      laneLabel: "status",
      retrievalPath: "hybrid",
      accessTrackedIds: ["semiote:m1"],
      prependContext: "## Recall\n- the capture hook writes semiote records directly",
      items: [{ id: "semiote:m1", score: 0.9 }],
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("prepend_context: $prependContext"),
      expect.objectContaining({
        prependContext: "## Recall\n- the capture hook writes semiote records directly",
      }),
    );
    // create stays single-purpose: feedback-only fields are never bound at create time
    const vars = (db.query as any).mock.calls[0][1];
    expect(vars).not.toHaveProperty("answer");
    expect(vars).not.toHaveProperty("responseResolution");
    expect(vars).not.toHaveProperty("correctedIds");
  });

  it("getRetrievalTrace maps the new feedback fields and tolerates pre-existing rows that lack them", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-9",
        user_id: "u1",
        prompt: "status?",
        intent_label: "current_status",
        lane_label: "status",
        retrieval_path: "hybrid",
        access_tracked_ids: ["semiote:m1"],
        items: [{ id: "semiote:m1", score: 0.9 }],
        prepend_context: "## Recall\n- fact",
        answer: "Yes, it writes semiote rows.",
        response_resolution: "explicit_success",
        corrected_ids: ["m2"],
        feedback_received_at: "2026-06-01T10:00:00.000Z",
        capture_receipt: {
          retrievalTraceId: "trace-9",
          sessionId: "sess-9",
          memoryIds: ["semiote:m1"],
          prompt: "status?",
          answer: "Yes, it writes semiote rows.",
          client: "grok",
          path: "/repo",
          receivedAt: "2026-06-01T10:00:01.000Z",
        },
        created_at: "2026-06-01T09:59:00.000Z",
      },
    ]]);
    const withFeedback = await getRetrievalTrace(db, "trace-9", "u1");
    expect(withFeedback).toMatchObject({
      id: "trace-9",
      prependContext: "## Recall\n- fact",
      answer: "Yes, it writes semiote rows.",
      responseResolution: "explicit_success",
      correctedIds: ["m2"],
      feedbackReceivedAt: "2026-06-01T10:00:00.000Z",
      captureReceipt: {
        retrievalTraceId: "trace-9",
        sessionId: "sess-9",
        memoryIds: ["semiote:m1"],
        prompt: "status?",
        answer: "Yes, it writes semiote rows.",
        client: "grok",
        path: "/repo",
        receivedAt: "2026-06-01T10:00:01.000Z",
      },
      items: [{ id: "semiote:m1", score: 0.9 }],
    });

    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-old",
        user_id: "u1",
        prompt: "older trace from before the augmentation",
        intent_label: "fact",
        lane_label: "fact",
        retrieval_path: "hybrid",
        access_tracked_ids: [],
        items: [],
        created_at: "2026-05-01T00:00:00.000Z",
      },
    ]]);
    const oldRow = await getRetrievalTrace(db, "trace-old", "u1");
    expect(oldRow?.prependContext).toBeUndefined();
    expect(oldRow?.answer).toBeUndefined();
    expect(oldRow?.responseResolution).toBeUndefined();
    expect(oldRow?.correctedIds).toBeUndefined();
    expect(oldRow?.feedbackReceivedAt).toBeUndefined();
    expect(oldRow?.captureReceipt).toBeUndefined();
    // existing projection still intact (protects the getRetrievalFootprintFromTrace consumer)
    expect(oldRow?.items).toEqual([]);
    expect(oldRow?.id).toBe("trace-old");
  });

  it("patchRetrievalTraceAnswer updates the trace with answer + feedback metadata, user-scoped", async () => {
    const db = mockDb();
    await patchRetrievalTraceAnswer(db, "trace-9", "u1", {
      answer: "Yes, it writes semiote rows.",
      responseResolution: "explicit_success",
      correctedIds: ["m2"],
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("answer = $answer"),
      expect.objectContaining({
        id: "trace-9",
        userId: "u1",
        answer: "Yes, it writes semiote rows.",
        responseResolution: "explicit_success",
        correctedIds: ["m2"],
      }),
    );
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain("feedback_received_at = time::now()");
    expect(sql).toContain("corrected_ids = $correctedIds");
    expect(sql).toContain("WHERE user_id = $userId");
  });

  it("patchRetrievalTraceAnswer coalesces omitted feedback metadata to undefined", async () => {
    const db = mockDb();
    await patchRetrievalTraceAnswer(db, "trace-9", "u1", { answer: "bare answer" });
    const vars = (db.query as any).mock.calls[0][1];
    expect(vars.responseResolution).toBeUndefined();
    expect(vars.correctedIds).toBeUndefined();
  });

  it("patchRetrievalTraceCaptureReceipt persists the bound headless turn metadata", async () => {
    const db = mockDb();
    await patchRetrievalTraceCaptureReceipt(db, "trace-9", "u1", {
      sessionId: "sess-9",
      memoryIds: ["semiote:m1", "semiote:m2"],
      prompt: "original prompt",
      answer: "final answer",
      client: "grok",
      path: "/repo",
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("capture_receipt ="),
      expect.objectContaining({
        id: "trace-9",
        userId: "u1",
        sessionId: "sess-9",
        memoryIds: ["semiote:m1", "semiote:m2"],
        prompt: "original prompt",
        answer: "final answer",
        client: "grok",
        path: "/repo",
      }),
    );
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).not.toContain("feedback_received_at");
    expect(sql).not.toMatch(/SET\s+answer\s*=/);
    expect(sql).toContain("retrievalTraceId: $id");
    expect(sql).toContain("receivedAt: time::now()");
    expect(sql).toContain("WHERE user_id = $userId");
  });

  it("listRetrievalTraces returns latest-N by user, omitting the heavy prepend_context/answer columns", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-2",
        user_id: "u1",
        prompt: "second",
        intent_label: "fact",
        lane_label: "fact",
        retrieval_path: "hybrid",
        access_tracked_ids: [],
        items: [{ id: "semiote:m1", score: 0.8 }],
        response_resolution: "explicit_success",
        feedback_received_at: "2026-06-01T10:00:00.000Z",
        created_at: "2026-06-01T09:00:00.000Z",
      },
      {
        id: "retrieval_trace:trace-1",
        user_id: "u1",
        prompt: "first",
        intent_label: "fact",
        lane_label: "fact",
        retrieval_path: "hybrid",
        access_tracked_ids: [],
        items: [],
        created_at: "2026-06-01T08:00:00.000Z",
      },
    ]]);
    const traces = await listRetrievalTraces(db, "u1", 50);
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain("WHERE user_id = $userId");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT $limit");
    // lightweight list payload: verbatim heavy columns are not fetched
    expect(sql).not.toContain("prepend_context");
    expect(sql).not.toContain("answer");
    expect((db.query as any).mock.calls[0][1]).toMatchObject({ userId: "u1", limit: 50 });
    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ id: "trace-2", responseResolution: "explicit_success" });
    expect(traces[0].prependContext).toBeUndefined();
    expect(traces[0].answer).toBeUndefined();
  });
});

describe("retrieval_trace THIN rating (A′ step 3 — recall-quality label)", () => {
  it("defines the additive rating / rating_note / rated_at fields on retrieval_trace", async () => {
    const db = mockDb();
    await ensurePhase2Schema(db);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS rating ON TABLE retrieval_trace TYPE option<string>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS rating_note ON TABLE retrieval_trace TYPE option<string>;"),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("DEFINE FIELD IF NOT EXISTS rated_at ON TABLE retrieval_trace TYPE option<datetime>;"),
    );
  });

  it("patchRetrievalTraceRating writes the label + note + rated_at, user-scoped", async () => {
    const db = mockDb();
    await patchRetrievalTraceRating(db, "trace-9", "u1", { rating: "helped", note: "nailed the config detail" });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("rating = $rating"),
      expect.objectContaining({ id: "trace-9", userId: "u1", rating: "helped", note: "nailed the config detail" }),
    );
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain("rated_at = time::now()");
    expect(sql).toContain("rating_note = $note");
    expect(sql).toContain("WHERE user_id = $userId");
  });

  it("patchRetrievalTraceRating coalesces an omitted note to undefined", async () => {
    const db = mockDb();
    await patchRetrievalTraceRating(db, "trace-9", "u1", { rating: "unused" });
    const vars = (db.query as any).mock.calls[0][1];
    expect(vars.rating).toBe("unused");
    expect(vars.note).toBeUndefined();
  });

  it("getRetrievalTrace maps the rating fields and tolerates rows that lack them", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-9",
        user_id: "u1",
        prompt: "status?",
        intent_label: "current_status",
        lane_label: "status",
        retrieval_path: "hybrid",
        access_tracked_ids: [],
        items: [],
        rating: "helped",
        rating_note: "great recall",
        rated_at: "2026-06-01T11:00:00.000Z",
        created_at: "2026-06-01T09:59:00.000Z",
      },
    ]]);
    const rated = await getRetrievalTrace(db, "trace-9", "u1");
    expect(rated).toMatchObject({ rating: "helped", ratingNote: "great recall", ratedAt: "2026-06-01T11:00:00.000Z" });

    db.query.mockResolvedValueOnce([[
      {
        id: "retrieval_trace:trace-unrated",
        user_id: "u1",
        prompt: "older trace",
        intent_label: "fact",
        lane_label: "fact",
        retrieval_path: "hybrid",
        access_tracked_ids: [],
        items: [],
        created_at: "2026-05-01T00:00:00.000Z",
      },
    ]]);
    const unrated = await getRetrievalTrace(db, "trace-unrated", "u1");
    expect(unrated?.rating).toBeUndefined();
    expect(unrated?.ratingNote).toBeUndefined();
    expect(unrated?.ratedAt).toBeUndefined();
  });

  it("listRetrievalTraces fetches the lightweight rating + rated_at but omits the heavier rating_note", async () => {
    const db = mockDb();
    db.query.mockResolvedValueOnce([[]]);
    await listRetrievalTraces(db, "u1", 20);
    const sql = (db.query as any).mock.calls[0][0] as string;
    // rating + rated_at are cheap and useful for a list view…
    expect(sql).toContain("rating");
    expect(sql).toContain("rated_at");
    // …but the note is free-text, so it stays out of the list payload (mirrors prepend_context/answer)
    expect(sql).not.toContain("rating_note");
  });

  describe("ensurePhase2Schema HNSW index dimension", () => {
    it("uses DIMENSION 768 by default (nomic / fallback embedding dimension)", async () => {
      const db = mockDb();
      await ensurePhase2Schema(db);
      const allSql = (db.query as any).mock.calls.map(([q]: [string]) => q).join("\n");
      expect(allSql).toContain("idx_semiote_embedding ON TABLE semiote FIELDS embedding HNSW DIMENSION 768");
      expect(allSql).toContain("idx_noema_embedding ON TABLE noema FIELDS embedding HNSW DIMENSION 768");
    });

    it("uses the configured embeddingDim (e.g. 1024 for bge-m3) in both HNSW DDL statements", async () => {
      const db = mockDb();
      await ensurePhase2Schema(db, 1024);
      const allSql = (db.query as any).mock.calls.map(([q]: [string]) => q).join("\n");
      expect(allSql).toContain("idx_semiote_embedding ON TABLE semiote FIELDS embedding HNSW DIMENSION 1024");
      expect(allSql).toContain("idx_noema_embedding ON TABLE noema FIELDS embedding HNSW DIMENSION 1024");
      // Confirm no stale 768 literal leaked into the HNSW index definitions
      expect(allSql).not.toMatch(/idx_semiote_embedding[^;]*DIMENSION 768/);
      expect(allSql).not.toMatch(/idx_noema_embedding[^;]*DIMENSION 768/);
    });

    it("preserves the rest of the HNSW parameters unchanged (DIST COSINE TYPE F32 EFC 150 M 12)", async () => {
      const db = mockDb();
      await ensurePhase2Schema(db, 1024);
      const allSql = (db.query as any).mock.calls.map(([q]: [string]) => q).join("\n");
      expect(allSql).toContain("HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12");
    });

    it("throws on a non-positive embeddingDim before issuing any DDL", async () => {
      const db = mockDb();
      await expect(ensurePhase2Schema(db, 0)).rejects.toThrow("invalid embeddingDim");
      await expect(ensurePhase2Schema(db, -1)).rejects.toThrow("invalid embeddingDim");
    });

    it("throws on a non-integer embeddingDim before issuing any DDL", async () => {
      const db = mockDb();
      await expect(ensurePhase2Schema(db, 1.5)).rejects.toThrow("invalid embeddingDim");
    });
  });
});
