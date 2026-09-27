import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceKeyFingerprint } from "../../capture/source-turn-identity.js";
import { verifiedSourceEligible } from "./verified-source-turns.js";
import { sourceRecallMode } from "../../recall/source-excerpts.js";

const key = "synthetic-test-key";
const text = "Synthetic identifier ORCHID-42 is valid only on Tuesday.";
const hmac = createHmac("sha256", key).update(text).digest("hex");
const fingerprint = sourceKeyFingerprint(key);
const boundary = { userId: "user-A", sessionId: "session-A" };
const baseFact = { id: "semiote:fact", user_id: "user-A", scope: "user", active: true,
  source_turn_id: "turn", source_turn_link_state: "linked", source_turn_hmac: hmac,
  source_turn_key_fingerprint: fingerprint, payload: {} };
const baseTurn = { id: "session_turn:turn", user_id: "user-A", scope: "user", role: "user",
  content_hmac: hmac, key_fingerprint: fingerprint, identity_quality: "native", retention_class: "linked" };
const eligible = (fact = baseFact as Record<string, any>, turn = baseTurn as Record<string, any>, content = text) =>
  verifiedSourceEligible(fact, turn, content, boundary, key);

describe("verified primary source eligibility", () => {
  it("keeps unknown recall flags off", () => {
    expect(sourceRecallMode("on")).toBe("on");
    expect(sourceRecallMode("shadow")).toBe("shadow");
    expect(sourceRecallMode("ON")).toBe("off");
    expect(sourceRecallMode("")).toBe("off");
  });
  it("requires the primary HMAC, latched fingerprint, and reassembled chunk content", () => {
    expect(eligible()).toBe(true);
    expect(eligible({ ...baseFact, source_turn_hmac: "wrong" })).toBe(false);
    expect(eligible({ ...baseFact, source_turn_key_fingerprint: "wrong" })).toBe(false);
    expect(eligible(baseFact, { ...baseTurn, key_fingerprint: "wrong" })).toBe(false);
    expect(eligible(baseFact, baseTurn, text + " altered")).toBe(false);
    expect(eligible({ ...baseFact, source_turn_id: undefined })).toBe(false);
  });

  it("rejects inactive, stale, invalidated, superseded, pending, unavailable and tool rows", () => {
    for (const patch of [{ active: false }, { active: undefined }, { invalid_at: "2026-01-01" },
      { payload: { invalidAt: "2026-01-01" } }, { superseded_by: "new" },
      { payload: { isStale: true } }, { source_turn_link_state: "pending" }, { source_turn_link_state: "unavailable" }])
      expect(eligible({ ...baseFact, ...patch })).toBe(false);
    expect(eligible(baseFact, { ...baseTurn, role: "tool" })).toBe(false);
    expect(eligible(baseFact, { ...baseTurn, role: "assistant" })).toBe(true);
  });

  it("accepts only verified Slice 3 legacy payloads", () => {
    const fact = { ...baseFact, source_turn_link_state: "legacy" };
    expect(eligible(fact, { ...baseTurn, identity_quality: "legacy_payload" })).toBe(true);
    expect(eligible(fact, baseTurn)).toBe(false);
    expect(eligible(fact, { ...baseTurn, identity_quality: "legacy_payload", retention_class: "unlinked" })).toBe(false);
  });

  it("checks the selected fact's scope, session, team, project and path", () => {
    expect(eligible({ ...baseFact, scope: undefined }, baseTurn)).toBe(true);
    expect(eligible({ ...baseFact, scope: "session", session_id: "session-A" },
      { ...baseTurn, scope: "session", session_id: "session-A" })).toBe(true);
    expect(eligible({ ...baseFact, scope: "session", session_id: "session-A" },
      { ...baseTurn, scope: "session", session_id: "other" })).toBe(false);
    expect(verifiedSourceEligible({ ...baseFact, scope: "session", session_id: "session-A" },
      { ...baseTurn, scope: "session", session_id: "session-A" }, text, { userId: "user-A", sessionId: "other" }, key)).toBe(false);
    expect(eligible({ ...baseFact, team_id: "A" }, { ...baseTurn, team_id: "B" })).toBe(false);
    expect(eligible({ ...baseFact, project_key: "A" }, { ...baseTurn, project_key: "B" })).toBe(false);
    expect(eligible(baseFact, { ...baseTurn, project_key: "turn-only" })).toBe(true);
    expect(eligible(baseFact, { ...baseTurn, path: "src/other.ts" })).toBe(false);
    expect(eligible({ ...baseFact, path: "src/own.ts" }, { ...baseTurn, path: "src/own.ts" })).toBe(true);
    expect(eligible({ ...baseFact, path: "src/own.ts" }, baseTurn)).toBe(true);
  });
});
