import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMPTY_PROFILE,
  parseRankingProfiles,
  loadRankingProfiles,
  resolveRankingProfile,
  resetRankingProfileCacheForTests,
  type RankingProfile,
} from "../recall/policy/ranking-profile";
import { applyStaleSignalDemotion, collapseContradictions } from "../recall/selection/recall-selection";
import { expandRetrievalQuery, entityMentionCandidates } from "../recall/query/memory-query";
import type { IntentSignal, QueryIntent } from "../recall/intent/intent-analyzer";
import type { SearchHit } from "../domain/memory/types";

const PROFILE_PATH = resolve(process.cwd(), "config/ranking-profiles.runir.json");

function loadRunirProfile(): RankingProfile {
  return parseRankingProfiles(JSON.parse(readFileSync(PROFILE_PATH, "utf8"))).get("owner")!;
}

function makeIntent(label: QueryIntent): IntentSignal {
  return { categories: [], depth: "full", confidence: 0.8, label };
}

function makeHit(id: string, score: number, text: string): SearchHit {
  return { id, text, score, createdAt: "2024-01-01" };
}

afterEach(() => {
  resetRankingProfileCacheForTests();
});

describe("ranking-profile: file loads + compiles", () => {
  it("parses the checked-in runir profile without error", () => {
    const profile = loadRunirProfile();
    expect(profile).toBeDefined();
    expect(Object.keys(profile.staleSignals).sort()).toEqual(
      ["architecture", "current_status", "debugging", "recent_work", "schema", "session_opener"],
    );
  });

  it("compiles all stale-signal regexes (round-trip {pattern,flags} → RegExp)", () => {
    const profile = loadRunirProfile();
    for (const regexes of Object.values(profile.staleSignals)) {
      for (const re of regexes) {
        expect(re).toBeInstanceOf(RegExp);
      }
    }
  });
});

// ── PROFILE-EQUALITY: file values reproduce the previously hard-coded behavior ──
// The constants were removed from source; these assert the lifted profile produces
// byte-identical ranking decisions for the patterns/words that were inlined.

describe("ranking-profile: equality with the removed constants (behavior-frozen)", () => {
  const profile = loadRunirProfile();

  it("STALE_SIGNALS.schema matches the same payload.data / payload.hash / runId patterns", () => {
    const sig = profile.staleSignals.schema;
    expect(sig.some((re) => re.test("Memory schema fields include payload.data."))).toBe(true);
    expect(sig.some((re) => re.test("payload.hash is computed at write time."))).toBe(true);
    expect(sig.some((re) => re.test("The runId is unique per session."))).toBe(true);
    expect(sig.some((re) => re.test("The memories table uses payload.l2."))).toBe(false);
  });

  it("STALE_SIGNALS.debugging matches the '313 tests passed' / NO-GO benchmark patterns (case-insensitive)", () => {
    const sig = profile.staleSignals.debugging;
    expect(sig.some((re) => re.test("After resolving a test failure, all 313 tests passed."))).toBe(true);
    expect(sig.some((re) => re.test("benchmark verdict: NO-GO"))).toBe(true);
  });

  it("STALE_SIGNALS.current_status matches Builder Brief / tsconfig.json / kebab-case noise", () => {
    const sig = profile.staleSignals.current_status;
    expect(sig.some((re) => re.test("The Builder Brief for MIM-71 ..."))).toBe(true);
    expect(sig.some((re) => re.test("scripts/ folder is not in tsconfig.json includes"))).toBe(true);
    expect(sig.some((re) => re.test("uses kebab-case for file names"))).toBe(true);
  });

  it("STALE_SIGNALS.current_status === STALE_SIGNALS.session_opener (identical pattern set)", () => {
    const cs = profile.staleSignals.current_status.map((re) => re.source + "|" + re.flags);
    const so = profile.staleSignals.session_opener.map((re) => re.source + "|" + re.flags);
    expect(so).toEqual(cs);
  });

  it("KNOWN_RENAMES carries the writeWithArbitration → arbitrateWrite pair", () => {
    expect(profile.knownRenames).toHaveLength(1);
    const [a, b] = profile.knownRenames[0];
    expect(a.test("processed through writeWithArbitration() for dedup")).toBe(true);
    expect(b.test("function is named arbitrateWrite")).toBe(true);
  });

  it("entityFillerWords contains the exact lifted set (paint, path, career, ...)", () => {
    for (const w of ["about", "career", "educaton", "education", "paint", "path", "pursue", "would"]) {
      expect(profile.entityFillerWords.has(w)).toBe(true);
    }
    expect(profile.entityFillerWords.size).toBe(27);
  });

  it("taxonomyExpansionFacets carries the career + education facets with exact terms", () => {
    expect(profile.taxonomyExpansionFacets).toHaveLength(2);
    expect(profile.taxonomyExpansionFacets[0].terms).toEqual(["career", "profession", "work"]);
    expect(profile.taxonomyExpansionFacets[1].terms).toEqual(["education", "training", "certification", "degree"]);
    expect(profile.taxonomyExpansionFacets[0].signals.has("career")).toBe(true);
    expect(profile.taxonomyExpansionFacets[1].signals.has("educaton")).toBe(true);
  });
});

// ── FRESH-TENANT: with no profile configured, all four consumers run clean ──

describe("ranking-profile: fresh tenant (EMPTY_PROFILE) = clean behavior", () => {
  it("EMPTY_PROFILE has no demotion lists / rename pairs / filler words / facets", () => {
    expect(Object.keys(EMPTY_PROFILE.staleSignals)).toHaveLength(0);
    expect(EMPTY_PROFILE.knownRenames).toHaveLength(0);
    expect(EMPTY_PROFILE.entityFillerWords.size).toBe(0);
    expect(EMPTY_PROFILE.taxonomyExpansionFacets).toHaveLength(0);
  });

  it("a hit matching /tsconfig.json/ is NOT demoted with no profile", () => {
    const hits = [
      makeHit("scaffold", 0.9, "scripts/ folder is not in tsconfig.json includes"),
      makeHit("fresh", 0.7, "Currently working on recall quality."),
    ];
    // No staleSignals slice → default EMPTY_PROFILE.staleSignals → no demotion.
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"));
    expect(demoted[0].id).toBe("scaffold");
    expect(demoted[0].score).toBeCloseTo(0.9);
    expect(staleDemotedIds.size).toBe(0);
  });

  it("the runir profile WOULD demote that same /tsconfig.json/ hit (control)", () => {
    const profile = loadRunirProfile();
    const hits = [
      makeHit("scaffold", 0.9, "scripts/ folder is not in tsconfig.json includes"),
      makeHit("fresh", 0.7, "Currently working on recall quality."),
    ];
    const { demoted, staleDemotedIds } = applyStaleSignalDemotion(hits, makeIntent("current_status"), profile.staleSignals);
    expect(demoted[0].id).toBe("fresh");
    expect(staleDemotedIds.has("scaffold")).toBe(true);
  });

  it("collapseContradictions does not collapse the rename pair with no profile", () => {
    const hits: SearchHit[] = [
      { id: "old", text: "All memory writes go through writeWithArbitration() for dedup.", score: 0.85, createdAt: "2026-03-10" },
      { id: "new", text: "The core write arbitration function is named arbitrateWrite.", score: 0.87, path: "/x", createdAt: "2026-03-29" },
    ];
    expect(collapseContradictions(hits)).toHaveLength(2);
  });

  it("'paint' survives entity-candidate filtering with no profile", () => {
    const normals = entityMentionCandidates("When did Melanie paint a sunrise?").map((c) => c.normalized);
    expect(normals).toContain("paint");
  });

  it("expandRetrievalQuery leaves a field query unchanged with no profile", () => {
    const q = "What fields would someone likely pursue in their educaton?";
    expect(expandRetrievalQuery(q)).toBe(q);
  });
});

// ── load + resolve cache ──

describe("ranking-profile: load + resolve", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("resolveRankingProfile returns EMPTY_PROFILE when no path configured", () => {
    loadRankingProfiles(undefined);
    expect(resolveRankingProfile("owner")).toBe(EMPTY_PROFILE);
    expect(resolveRankingProfile("anyone")).toBe(EMPTY_PROFILE);
  });

  it("loadRankingProfiles(path) resolves the owner profile and falls back to EMPTY for others", () => {
    loadRankingProfiles(PROFILE_PATH);
    const owner = resolveRankingProfile("owner");
    expect(owner.knownRenames).toHaveLength(1);
    expect(resolveRankingProfile("stranger")).toBe(EMPTY_PROFILE);
  });

  it("loadRankingProfiles(undefined) returns a quiet empty map (path unset)", () => {
    const map = loadRankingProfiles(undefined);
    expect(map.size).toBe(0);
    expect(resolveRankingProfile("owner")).toBe(EMPTY_PROFILE);
  });

  it("path SET but file is malformed JSON THROWS (fail loud, no silent fallback)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ranking-profile-"));
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, "{ not valid json", "utf8");
    expect(() => loadRankingProfiles(bad)).toThrow();
  });

  it("path SET but file is schema-invalid THROWS (fail loud)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ranking-profile-"));
    const invalid = join(tmp, "invalid.json");
    // Valid JSON, but a userId-less profile entry fails the zod schema.
    writeFileSync(invalid, JSON.stringify({ profiles: [{ staleSignals: {} }] }), "utf8");
    expect(() => loadRankingProfiles(invalid)).toThrow();
  });

  it("path SET but file is MISSING THROWS (fail loud)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ranking-profile-"));
    const missing = join(tmp, "does-not-exist.json");
    expect(() => loadRankingProfiles(missing)).toThrow();
  });

  it("parseRankingProfiles throws on an invalid regex pattern (fail loud)", () => {
    expect(() =>
      parseRankingProfiles({
        profiles: [{ userId: "x", staleSignals: { schema: [{ pattern: "(", flags: "" }] } }],
      }),
    ).toThrow();
  });
});
