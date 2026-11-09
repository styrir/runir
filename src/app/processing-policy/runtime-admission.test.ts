import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmbedDocument, mockArbitrateWrite } = vi.hoisted(() => ({
  mockEmbedDocument: vi.fn().mockResolvedValue([1, 0, 0]),
  mockArbitrateWrite: vi.fn().mockResolvedValue({ outcome: "skip", memoryId: null, matchedMemoryId: null }),
}));

vi.mock("../../shared/config.js", () => ({
  parseConfig: vi.fn().mockReturnValue({
    userId: "default-user",
    autoRecall: true,
    autoCapture: true,
    topK: 5,
    customPrompt: undefined,
    surrealdb: { url: "http://localhost:8000", username: "root", password: "", namespace: "main", database: "main" },
    embedder: { provider: "local", model: "fixture", baseURL: "http://localhost:11434", dimensions: 3, timeoutMs: 1000 },
    reranker: { provider: "local" },
  }),
  validateRerankerConfig: vi.fn(),
  resolveEmbeddingProvider: vi.fn().mockReturnValue({
    embedQuery: vi.fn().mockResolvedValue([1, 0, 0]),
    embedDocument: mockEmbedDocument,
    fingerprint: vi.fn().mockReturnValue("fixture-fingerprint"),
  }),
  resolveCaptureApiKey: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../shared/bind-host.js", () => ({ resolveBindHost: vi.fn().mockReturnValue("127.0.0.1") }));
vi.mock("../supersession-judge.js", () => ({ buildSupersessionJudge: vi.fn().mockReturnValue(undefined) }));
vi.mock("../../storage/surreal/surreal-store.js", () => ({
  SurrealClient: class MockSurrealClient {},
  getEmbeddingFingerprint: vi.fn().mockResolvedValue(null),
  setEmbeddingFingerprint: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../storage/surreal/phase2-store.js", () => ({
  buildSemioteProvenanceEnvelope: vi.fn(),
  getHexisById: vi.fn(),
  getHexisByScopeKey: vi.fn(),
  initializeSemioteSemiosis: vi.fn(),
  patchSemioteProvenance: vi.fn(),
}));
vi.mock("../../storage/writes/write-arbitrator.js", () => ({ arbitrateWrite: mockArbitrateWrite }));
vi.mock("../../shared/debug-logger.js", () => ({ makeDebugLogger: vi.fn().mockReturnValue({}) }));
vi.mock("../../recall/selection/retrieval-stats.js", () => ({ RetrievalStatsCollector: class MockRetrievalStatsCollector {} }));
vi.mock("../../capture/extraction/noise-prototype-bank.js", () => ({ NoisePrototypeBank: class MockNoisePrototypeBank {} }));
vi.mock("../../lifecycle/semion/usefulness-feedback.js", () => ({
  initializeUsefulnessState: vi.fn().mockReturnValue({ usefulnessAlpha: 1, usefulnessBeta: 1, usefulnessScore: 0.5 }),
}));
vi.mock("../../storage/overlay/overlay-store.js", () => ({
  createOverlayRegistry: vi.fn().mockReturnValue({}),
}));

import {
  createProducerAuthority,
  createServerAuthenticatedProducerPrincipal,
  createServerSelectedProducerOperation,
  createServerResolvedTargetUser,
  createTrustedProducerRegistration,
  removeProducerRegistration,
  revokeProducerRegistration,
  type ProcessingPolicyContext,
} from "./authority.js";
import { writeWithArbitration } from "../runtime.js";

function validContextFixture(operation: "capture_ingest" | "scheduled_maintenance" | "forced_maintenance" = "capture_ingest") {
  const principal = createServerAuthenticatedProducerPrincipal(`runtime-test-${operation}`);
  const targetUser = createServerResolvedTargetUser("owner");
  const registration = createTrustedProducerRegistration({
    registrationRef: `runtime-test-registration-${operation}`,
    principalRef: principal.principalRef,
    authorizedOperations: [operation],
    authorizedTargetUsers: [targetUser.userId],
  });
  const authority = createProducerAuthority([registration]);
  const admission = authority.resolve({
    principal,
    operation: createServerSelectedProducerOperation(operation),
    targetUser,
  });
  if (!admission.ok) throw new Error("fixture admission unexpectedly refused");
  return { authority, principal, targetUser, registration, context: admission.context };
}

function validContext(operation: "capture_ingest" | "scheduled_maintenance" | "forced_maintenance" = "capture_ingest"): ProcessingPolicyContext {
  return validContextFixture(operation).context;
}

async function expectRuntimeRefusal(
  context: unknown,
  reason: string,
  userId = "owner",
) {
  vi.clearAllMocks();
  await expect(writeWithArbitration({
    text: "synthetic protected fact",
    userId,
    metadata: {},
    scope: "user",
    source: "agent_end",
    writeSource: "capture",
    targetTable: "semiote",
    processingPolicyContext: context as ProcessingPolicyContext,
  })).rejects.toMatchObject({
    code: "producer_policy_refused",
    reason,
    contentFree: true,
  });
  expect(mockEmbedDocument).not.toHaveBeenCalled();
  expect(mockArbitrateWrite).not.toHaveBeenCalled();
}

describe("runtime producer admission fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArbitrateWrite.mockResolvedValue({ outcome: "skip", memoryId: null, matchedMemoryId: null });
  });

  it("refuses a forged context before embedding or arbitration", async () => {
    await expect(writeWithArbitration({
      text: "synthetic protected fact",
      userId: "owner",
      metadata: {},
      scope: "user",
      source: "agent_end",
      writeSource: "capture",
      targetTable: "semiote",
      processingPolicyContext: {} as ProcessingPolicyContext,
    })).rejects.toMatchObject({
      code: "producer_policy_refused",
      reason: "context_invalid",
      contentFree: true,
    });
    expect(mockEmbedDocument).not.toHaveBeenCalled();
    expect(mockArbitrateWrite).not.toHaveBeenCalled();
  });

  it("allows a synthetic admitted context to reach the existing runtime seam", async () => {
    const result = await writeWithArbitration({
      text: "synthetic protected fact",
      userId: "owner",
      metadata: {},
      scope: "user",
      source: "agent_end",
      writeSource: "capture",
      targetTable: "semiote",
      processingPolicyContext: validContext(),
    });

    expect(result.outcome).toBe("skip");
    expect(mockEmbedDocument).toHaveBeenCalledWith("synthetic protected fact");
    expect(mockArbitrateWrite).toHaveBeenCalledOnce();
  });

  it("refuses contexts revoked or removed after admission before any effect", async () => {
    const revokedFixture = validContextFixture();
    revokeProducerRegistration(revokedFixture.authority, revokedFixture.registration.registrationRef);
    await expectRuntimeRefusal(revokedFixture.context, "registration_revoked");

    const staleFixture = validContextFixture();
    removeProducerRegistration(staleFixture.authority, staleFixture.registration.registrationRef);
    await expectRuntimeRefusal(staleFixture.context, "registration_missing");
  });

  it("refuses inherited, descriptor-forged, spread, and JSON-built contexts before effects", async () => {
    const context = validContext();
    const inherited = Object.create(context) as Record<string, unknown>;
    const descriptorForged = Object.create(context) as Record<string, unknown>;
    Object.defineProperty(descriptorForged, "targetUserId", { configurable: true, value: "other-user" });
    const forgeries: unknown[] = [
      inherited,
      descriptorForged,
      { ...context },
      JSON.parse(JSON.stringify(context)),
    ];

    for (const forgery of forgeries) {
      await expectRuntimeRefusal(forgery, "context_invalid");
    }
  });

  it("binds the runtime fence to the actual user and capture-ingest operation", async () => {
    const userFixture = validContextFixture();
    await expectRuntimeRefusal(userFixture.context, "target_user_mismatch", "other-user");

    const maintenanceFixture = validContextFixture("forced_maintenance");
    await expectRuntimeRefusal(maintenanceFixture.context, "operation_mismatch");
  });

  it("rechecks expiry after admission before embedding", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const principal = createServerAuthenticatedProducerPrincipal("runtime-expiring-producer");
    const targetUser = createServerResolvedTargetUser("owner");
    const registration = createTrustedProducerRegistration({
      registrationRef: "runtime-expiring-registration",
      principalRef: principal.principalRef,
      authorizedOperations: ["capture_ingest"],
      authorizedTargetUsers: [targetUser.userId],
      expiresAt,
    });
    const authority = createProducerAuthority([registration]);
    const admission = authority.resolve({
      principal,
      operation: createServerSelectedProducerOperation("capture_ingest"),
      targetUser,
    });
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;

    vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
    await expectRuntimeRefusal(admission.context, "registration_expired");
  });
});
