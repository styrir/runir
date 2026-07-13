import { describe, expect, it } from "vitest";
import type { SearchHit } from "../domain/memory/types";
import { buildPreferencePacket } from "../recall/policy/preference-packet.js";
import type { IntentSignal } from "../recall/intent/intent-analyzer.js";

const preferenceIntent: IntentSignal = {
  label: "preference",
  categories: ["preferences"],
  depth: "l0",
  confidence: 0.9,
};

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, "id" | "text">): SearchHit {
  return {
    score: 0.9,
    createdAt: "2026-05-14T10:00:00Z",
    ...overrides,
  };
}

describe("JIT preference packet", () => {
  it("orders hard constraints before softer preferences and marks data untrusted", () => {
    const packet = buildPreferencePacket([
      hit({
        id: "semiote:style",
        text: "User prefers concise summaries.",
        category: "preferences",
      }),
      hit({
        id: "noema:privacy",
        text: "Never include secrets or credentials in generated output.",
        category: "preferences",
      }),
    ], { intent: preferenceIntent });

    expect(packet?.trust).toBe("untrusted_retrieved_data");
    expect(packet?.categoryOrder[0]).toBe("hard_constraints_safety_privacy");
    expect(packet?.categories.hard_constraints_safety_privacy[0]).toMatchObject({
      id: "noema:privacy",
      sourceKind: "noema",
      trust: "untrusted_retrieved_data",
    });
    expect(packet?.categories.communication_style[0].id).toBe("semiote:style");
  });

  it("excludes unrelated hits and keeps a traceable audit list", () => {
    const packet = buildPreferencePacket([
      hit({ id: "semiote:pref", text: "Use Vitest for focused tests.", category: "preferences" }),
      hit({ id: "semiote:event", text: "The build ran yesterday.", category: "events" }),
    ], { intent: { ...preferenceIntent, label: "fact" } });

    expect(packet?.audit.selectedIds).toEqual(["semiote:pref"]);
    expect(packet?.audit.excludedIds).toEqual(["semiote:event"]);
    expect(packet?.categories.tools_environment[0].text).toBe("Use Vitest for focused tests.");
  });

  it("truncates deterministically by token budget", () => {
    const packet = buildPreferencePacket([
      hit({ id: "semiote:first", text: "User prefers short direct answers.", category: "preferences" }),
      hit({ id: "semiote:second", text: "User prefers detailed implementation walkthroughs.", category: "preferences" }),
    ], { intent: preferenceIntent, tokenBudget: 10 });

    expect(packet?.audit.selectedIds).toEqual(["semiote:first"]);
    expect(packet?.audit.excludedIds).toEqual(["semiote:second"]);
    expect(packet?.audit.truncated).toBe(true);
  });

  it("truncates by category priority before recall score", () => {
    const packet = buildPreferencePacket([
      hit({
        id: "semiote:soft",
        text: "User prefers chatty summaries.",
        category: "preferences",
        score: 0.99,
      }),
      hit({
        id: "noema:hard",
        text: "Never include secrets.",
        category: "preferences",
        score: 0.1,
      }),
    ], { intent: preferenceIntent, tokenBudget: 8 });

    expect(packet?.audit.selectedIds).toEqual(["noema:hard"]);
    expect(packet?.audit.excludedIds).toEqual(["semiote:soft"]);
    expect(packet?.audit.truncated).toBe(true);
    expect(packet?.audit.truncationStrategy).toBe("category_priority_then_score");
    expect(packet?.categories.hard_constraints_safety_privacy[0].id).toBe("noema:hard");
  });
});
