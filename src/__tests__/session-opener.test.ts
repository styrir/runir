import { describe, expect, it } from "vitest";
import { analyzeIntent } from "../recall/intent/intent-analyzer.js";
import { postProcessRecallResults } from "../recall/selection/recall-selection.js";
import { buildSessionOpenerPayload, renderSessionOpenerYaml } from "../recall/continuity/session-opener.js";
import type { ProjectStateRecord, SearchHit } from "../domain/memory/types.js";

describe("postProcessRecallResults — session_opener gating", () => {
  it("prefers status continuity over setup noise for session_opener", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const hits: SearchHit[] = [
      {
        id: "noise-1",
        text: "scripts/ folder is not in tsconfig.json includes. Use npx tsx for script runs.",
        score: 0.99,
        memoryRole: "operational_noise",
        path: requestedPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "status-1",
        text: "Current status: working on continuity-first recall routing in /hooks/recall.",
        score: 0.7,
        memoryRole: "current_status",
        path: requestedPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "handoff-1",
        text: "Session handoff: next step is improving session opener output shape.",
        score: 0.65,
        memoryRole: "session_handoff",
        path: requestedPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const { selected } = postProcessRecallResults(hits, {
      intent: analyzeIntent("let's continue where we left off"),
      topK: 3,
      requestedPath,
    });

    expect(selected[0]?.id).toBe("status-1");
    expect(selected.some((hit) => hit.id === "handoff-1")).toBe(true);
    expect(selected.some((hit) => hit.id === "noise-1")).toBe(false);
  });
});

describe("session opener payload builder", () => {
  it("prefers concrete continuity hits over verbose project_state summaries and suppresses env noise", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const payload = buildSessionOpenerPayload({
      projectState: {
        id: "ps-verbose",
        userId: "owner",
        path: requestedPath,
        currentFocus: "Current hook implementation status: UserPromptSubmit correctly triggers /hooks/recall via lib/http.sh with aligned prod tokens. However, /hooks/capture is not firing because no hook file exists for Claude Code and the project state still contains implementation-history-heavy notes.",
        activeTicketIds: [],
        latestProgress: "The discussion identified a third major gap: the client fails to send a sessionId in recall payloads, causing orphaned retrieval traces, and the SessionStart event remains unused for structured opener recall.",
        blockers: [],
        nextSteps: ["Investigate recall quality and tighten opener shaping"],
        updatedAt: "2026-04-01T12:00:00.000Z",
        sourceSessionId: "s1",
        supportingMemoryIds: ["m1"],
        confidence: 0.9,
        version: 1,
      },
      hits: [
        {
          id: "status-1",
          text: "Current status: investigating opener quality for the Claude smoke session.",
          score: 0.9,
          memoryRole: "current_status",
          l0: "Opener quality investigation",
          path: requestedPath,
          updatedAt: "2026-04-01T12:01:00.000Z",
        },
        {
          id: "handoff-1",
          text: "Session handoff: next step is routing opener-like prompts into deterministic continuity.",
          score: 0.8,
          memoryRole: "session_handoff",
          l0: "Route opener-like prompts",
          path: requestedPath,
          updatedAt: "2026-04-01T12:02:00.000Z",
        },
        {
          id: "noise-1",
          text: "Rúnir Read Path Gating: recall should only trigger during session starts, explicit state checks, or context insufficiency. The project_state update flow uses /clear and watermark progression to preserve continuity.",
          score: 0.7,
          memoryRole: "current_status",
          l0: "Read-path gating",
          path: requestedPath,
          updatedAt: "2026-04-01T12:03:00.000Z",
        },
      ],
      requestedPath,
    });

    expect(payload).not.toBeNull();
    expect(payload?.focus[0]).toContain("investigating opener quality");
    expect(payload?.focus[0]).not.toContain("UserPromptSubmit correctly triggers");
    expect(payload?.focus.join("\n")).not.toContain("Read Path Gating");
    expect(payload?.scope.project).toBe("Opener quality investigation");
    expect(payload?.scope.area).toBe("runir");
    expect(payload?.next).toEqual(expect.arrayContaining([
      expect.stringContaining("routing opener-like prompts into deterministic continuity"),
    ]));
    expect(payload?.env).toEqual([]);
  });

  it("builds structured sections and keeps env notes supplemental", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const projectState: ProjectStateRecord = {
      id: "ps-1",
      userId: "owner",
      path: requestedPath,
      currentFocus: "continuity-first recall",
      activeTicketIds: ["MIM-100"],
      latestProgress: "current_status/session_opener can early-return before embedding/vector search",
      blockers: [],
      nextSteps: ["improve session-opener output shape"],
      updatedAt: "2026-04-01T12:00:00.000Z",
      sourceSessionId: "s1",
      supportingMemoryIds: ["m1"],
      confidence: 0.9,
      version: 1,
    };

    const hits: SearchHit[] = [
      {
        id: "status-1",
        text: "Current status: /hooks/recall prioritizes project-state and continuity lookups.",
        score: 0.9,
        memoryRole: "current_status",
        l0: "Continuity-First Recall Routing",
        path: requestedPath,
        updatedAt: "2026-04-01T12:00:00.000Z",
      },
      {
        id: "plan-1",
        text: "Next step: suppress noisy historical/debug-style memory in final opener.",
        score: 0.8,
        memoryRole: "planning_active",
        l0: "Opener Follow-up",
        path: requestedPath,
        updatedAt: "2026-04-01T12:05:00.000Z",
      },
      {
        id: "noise-1",
        text: "scripts/ folder is not in tsconfig.json includes. Use npx tsx for script runs.",
        score: 0.7,
        memoryRole: "operational_noise",
        l0: "Project State / Execution",
        path: requestedPath,
        updatedAt: "2026-04-01T12:06:00.000Z",
      },
    ];

    const payload = buildSessionOpenerPayload({
      projectState,
      hits,
      requestedPath,
      usedPathFallback: true,
    });

    expect(payload).not.toBeNull();
    expect(payload?.intent).toBe("continue_previous_work");
    expect(payload?.warnings).toContain("path_fallback_used");
    expect(payload?.focus).toEqual(expect.arrayContaining([expect.stringContaining("/hooks/recall prioritizes project-state and continuity lookups")]));
    expect(payload?.next).toEqual(expect.arrayContaining([
      expect.stringContaining("improve session-opener output shape"),
      expect.stringContaining("suppress noisy historical/debug-style memory"),
    ]));
    expect(payload?.env).toEqual([]);
    expect(payload?.evidenceTitles).toEqual(expect.arrayContaining(["Project State / Current Status", "Continuity-First Recall Routing"]));
  });

  it("keeps demoted env notes in env via supplemental hits", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const payload = buildSessionOpenerPayload({
      projectState: null,
      hits: [{
        id: "status-1",
        text: "Current status: working on continuity-first recall.",
        score: 0.8,
        memoryRole: "current_status",
        l0: "Continuity-First Recall",
        path: requestedPath,
        updatedAt: "2026-04-01T12:00:00.000Z",
      }],
      supplementalHits: [{
        id: "noise-1",
        text: "scripts/ folder is not in tsconfig.json includes. Use npx tsx for script runs.",
        score: 0.95,
        l0: "Project State / Execution",
        path: requestedPath,
        updatedAt: "2026-04-01T12:01:00.000Z",
      }],
      requestedPath,
    });

    expect(payload).not.toBeNull();
    expect(payload?.focus).toEqual([expect.stringContaining("Current status")]);
    expect(payload?.env).toEqual([]);
    expect(payload?.evidence.supplemental).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Project State / Execution" }),
    ]));
    expect(payload?.warnings).toContain("transitional_memory_admitted");
  });

  it("renders inferred next steps for blocked rollout memories", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const payload = buildSessionOpenerPayload({
      projectState: null,
      hits: [{
        id: "auth-blocker",
        text: "The deployment of auth-service v3 is currently blocked by the pending rollout of the JWT_EXPIRY environment variable to the staging environment.",
        score: 0.9,
        memoryRole: "debugging_active",
        l0: "Blocker: auth-service v3 deploy requires JWT_EXPIRY env-var rollout in staging",
        path: requestedPath,
        updatedAt: "2026-04-30T12:00:00.000Z",
      }],
      requestedPath,
    });

    expect(payload).not.toBeNull();
    expect(payload?.status).toBe("blocked");
    expect(payload?.next).toEqual([
      "Complete the JWT_EXPIRY environment variable rollout to the staging environment.",
    ]);
    const rendered = renderSessionOpenerYaml(payload!);
    expect(rendered).toContain("next:");
    expect(rendered).toContain("Complete the JWT_EXPIRY environment variable rollout to the staging environment.");
  });

  it("renders typed continuity directives distinctly while preserving legacy blockers and next steps", () => {
    const requestedPath = "/Users/brooks/Code/runir";
    const projectState: ProjectStateRecord = {
      id: "ps-directives",
      userId: "owner",
      path: requestedPath,
      currentFocus: "continuity directives",
      activeTicketIds: [],
      latestProgress: "session opener carries typed continuity directives",
      blockers: ["Legacy blocker remains visible"],
      nextSteps: ["Legacy next step remains visible"],
      directives: [
        { kind: "action", polarity: "do", status: "open", text: "Ship the directive schema", source: "explicit", confidence: 0.9, evidence: "Ship the directive schema" },
        { kind: "avoidance", polarity: "do_not", status: "open", text: "broaden blocker regexes into mini-NLP", source: "explicit", confidence: 0.9, evidence: "do not broaden blocker regexes" },
        { kind: "blocker", polarity: "wait_for", status: "blocked", text: "auth-service v3 is blocked until JWT_EXPIRY lands in staging", target: "JWT_EXPIRY rollout to staging", owner: "external", source: "explicit", confidence: 0.95, evidence: "can't deploy v3 until JWT_EXPIRY lands in staging" },
        { kind: "question", polarity: "ask", status: "open", text: "which deployment account to use", source: "explicit", confidence: 0.8, evidence: "ask which account" },
        { kind: "verification", polarity: "verify", status: "open", text: "CI is green before merge", source: "explicit", confidence: 0.9, evidence: "verify CI before merge" },
        { kind: "decision", polarity: "decide", status: "done", text: "Use deterministic recall rendering", source: "explicit", confidence: 0.9, evidence: "decision: deterministic recall rendering" },
      ],
      updatedAt: "2026-05-11T08:00:00.000Z",
      sourceSessionId: "s1",
      supportingMemoryIds: ["m1"],
      confidence: 0.9,
      version: 1,
    };

    const payload = buildSessionOpenerPayload({
      projectState,
      hits: [],
      requestedPath,
    });

    expect(payload).not.toBeNull();
    expect(payload?.status).toBe("blocked");
    expect(payload?.state.join("\n")).toContain("Legacy blocker remains visible");
    expect(payload?.state.join("\n")).toContain("auth-service v3 is blocked until JWT_EXPIRY lands in staging");
    expect(payload?.next.join("\n")).toContain("Ship the directive schema.");
    expect(payload?.next.join("\n")).toContain("Avoid: broaden blocker regexes into mini-NLP.");
    expect(payload?.directives.map((directive) => directive.kind)).toEqual([
      "action",
      "avoidance",
      "blocker",
      "question",
      "verification",
      "decision",
    ]);

    const rendered = renderSessionOpenerYaml(payload!);
    expect(rendered).toContain("directives:");
    expect(rendered).toContain('text: "Ship the directive schema"');
    expect(rendered).toContain('next: "Ship the directive schema."');
    expect(rendered).toContain('next: "Avoid: broaden blocker regexes into mini-NLP."');
    expect(rendered).toContain('target: "JWT_EXPIRY rollout to staging"');
    expect(rendered).toContain('next: "Wait for JWT_EXPIRY rollout to staging."');
    expect(rendered).toContain('next: "Ask: which deployment account to use."');
    expect(rendered).toContain('next: "Verify: CI is green before merge."');
    expect(rendered).toContain('text: "Use deterministic recall rendering"');
    expect(rendered).not.toContain("next: Use deterministic recall rendering");
  });

  it("renders yaml-like opener output", () => {
    const payload = buildSessionOpenerPayload({
      projectState: null,
      hits: [{
        id: "status-1",
        text: "Current status: working on continuity-first recall.",
        score: 0.8,
        memoryRole: "current_status",
        l0: "Continuity-First Recall",
        updatedAt: "2026-04-01T12:00:00.000Z",
      }],
      requestedPath: "/Users/brooks/Code/runir",
    });

    expect(payload).not.toBeNull();
    const rendered = renderSessionOpenerYaml(payload!);
    expect(rendered).toContain("session_opener:");
    expect(rendered).toContain("intent: continue_previous_work");
    expect(rendered).toContain("focus:");
    expect(rendered).toContain("evidence_titles:");
  });
});
