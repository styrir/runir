import { describe, it, expect, vi, beforeEach } from "vitest";

import { extractMemories } from "../capture/extraction/capture.js";

// Mock fetch so we can drive the LLM response shape.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

type LLMFact = {
  l2: string;
  confidence: number;
  source_turn_index?: number;
};

function makeOpenRouterResponse(facts: LLMFact[]) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ facts }) } }],
    }),
  };
}

const DIFF_USER_TURN = [
  "Here is the diff I'm about to merge — does it look safe?",
  "",
  "```diff",
  "--- a/src/billing/invoice-generator.ts",
  "+++ b/src/billing/invoice-generator.ts",
  "@@ -88,7 +88,10 @@ export async function generateInvoice(",
  "   const lineItems = await resolveLineItems(order);",
  "-  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);",
  "+  const subtotal = lineItems.reduce(",
  "+    (sum, li) => sum + li.amount * (li.quantity ?? 1),",
  "+    0,",
  "+  );",
  "   const tax = computeTax(subtotal, order.taxRegion);",
  "```",
].join("\n");

const ASSISTANT_REPLY =
  "The change looks safe. It corrects the `subtotal` calculation to multiply " +
  "`li.amount` by `li.quantity` (defaulting to 1 if absent), which was " +
  "previously ignored. This is a bug fix for orders with multi-unit line items.";

describe("extractMemories — raw_source_text stamping (Rúnir-o2kz close-gap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: LLM emits source_turn_index=0 → raw_source_text contains the user diff fence verbatim", async () => {
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          // Mirrors the production paraphrase from the seed-07 runtime bundle
          // (docs/baselines/runtime-comparison-2026-05-16.html). The
          // long contiguous match with the assistant reply is exactly what
          // tripped the fuzzy fallback's LCS heuristic in production.
          l2: "Bug fix in `src/billing/invoice-generator.ts`: The `subtotal` calculation in `generateInvoice` was updated to multiply `li.amount` by `li.quantity` (defaulting to 1). Previously, the calculation only summed `li.amount`, ignoring quantities for multi-unit line items.",
          confidence: 0.95,
          source_turn_index: 0,
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: DIFF_USER_TURN },
        { role: "assistant", content: ASSISTANT_REPLY },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    expect(fact.raw_source_text).toBeDefined();
    // Verbatim diff content must be preserved.
    expect(fact.raw_source_text).toContain("```diff");
    expect(fact.raw_source_text).toContain("@@ -88,7 +88,10");
    // It must NOT be the assistant's reply.
    expect(fact.raw_source_text).not.toContain("The change looks safe");
  });

  it("missing source_turn_index: raw_source_text MUST stay empty (not fuzzy-match the assistant reply)", async () => {
    // Reproduces the Rúnir-o2kz failure mode: when source_turn_index is
    // missing, the old fuzzy-LCS fallback matched the LLM-paraphrased l2
    // against every message and picked whichever had the longest common
    // substring — which is almost always the assistant's analysis turn for
    // code-bearing user turns. After the fix, no fuzzy fallback runs: the
    // scorer's downstream `bundle-turn-text-via-source_turn` path handles
    // recovery cleanly.
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          // Mirrors the production paraphrase from the seed-07 runtime bundle
          // (docs/baselines/runtime-comparison-2026-05-16.html). The
          // long contiguous match with the assistant reply is exactly what
          // tripped the fuzzy fallback's LCS heuristic in production.
          l2: "Bug fix in `src/billing/invoice-generator.ts`: The `subtotal` calculation in `generateInvoice` was updated to multiply `li.amount` by `li.quantity` (defaulting to 1). Previously, the calculation only summed `li.amount`, ignoring quantities for multi-unit line items.",
          confidence: 0.95,
          // source_turn_index intentionally omitted
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: DIFF_USER_TURN },
        { role: "assistant", content: ASSISTANT_REPLY },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    // Empty / undefined / null are all acceptable post-fix; the assistant
    // reply substring must NOT appear.
    expect(fact.raw_source_text ?? "").not.toContain("The change looks safe");
    // And it certainly must not have synthesised the wrong turn's body.
    expect(fact.raw_source_text ?? "").not.toContain("multi-unit line items");
  });

  it("out-of-range source_turn_index: raw_source_text MUST stay empty (no fuzzy fallback)", async () => {
    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          // Mirrors the production paraphrase from the seed-07 runtime bundle
          // (docs/baselines/runtime-comparison-2026-05-16.html). The
          // long contiguous match with the assistant reply is exactly what
          // tripped the fuzzy fallback's LCS heuristic in production.
          l2: "Bug fix in `src/billing/invoice-generator.ts`: The `subtotal` calculation in `generateInvoice` was updated to multiply `li.amount` by `li.quantity` (defaulting to 1). Previously, the calculation only summed `li.amount`, ignoring quantities for multi-unit line items.",
          confidence: 0.95,
          source_turn_index: 42, // intentionally out of range
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: DIFF_USER_TURN },
        { role: "assistant", content: ASSISTANT_REPLY },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    expect(fact.raw_source_text ?? "").not.toContain("The change looks safe");
  });

  it("relocated override: a later unrelated fence must NOT overwrite the source_turn_index turn (Rúnir-sm9k.2)", async () => {
    // The relocated o2kz bug: the `factMentionsCode` fallback used to walk ALL
    // messages newest-first and stamp the LATEST code-bearing turn, ignoring
    // source_turn_index. So a fenced turn that appears AFTER the real source
    // (e.g. an unrelated example the assistant pastes later) would overwrite
    // the correct user-source turn. The fact below correctly points at turn 0
    // (a user note that only mentions identifiers via inline backticks), but a
    // later turn 2 carries a ```sql fence. The stamp must stay on turn 0.
    const USER_NOTE_TURN =
      "Remember for later: I want all SQL identifiers quoted with backticks, like `user_id` and `order_total`.";
    const ASSISTANT_ACK = "Understood — I'll quote SQL identifiers with backticks.";
    const LATER_FENCE_TURN = [
      "Here is an unrelated example query from another thread:",
      "",
      "```sql",
      "SELECT * FROM orders WHERE status = 'open';",
      "```",
    ].join("\n");

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "User prefers SQL identifiers quoted with backticks, e.g. `user_id`.",
          confidence: 0.95,
          source_turn_index: 0,
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: USER_NOTE_TURN },
        { role: "assistant", content: ASSISTANT_ACK },
        { role: "assistant", content: LATER_FENCE_TURN },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    expect(fact.raw_source_text).toBeDefined();
    // Must resolve to the source_turn_index turn (the user note), NOT the later fence.
    expect(fact.raw_source_text).toContain("Remember for later");
    expect(fact.raw_source_text).not.toContain("```sql");
    expect(fact.raw_source_text).not.toContain("SELECT * FROM orders");
  });

  it("neighbor recovery: an indexed non-code turn still recovers a fenced neighbor (idx-1)", async () => {
    // Guards against over-restricting the fix: when the LLM mis-points
    // source_turn_index at a non-code-bearing assistant turn but the verbatim
    // source sits in the immediately-prior user turn, the neighbor scan
    // ([idx, idx-1]) must still recover it. This must keep working after the
    // global newest-first sweep is replaced by a neighbor-only scan.
    const USER_DIFF_TURN = [
      "Please remember this hunk:",
      "",
      "```diff",
      "@@ -1,2 +1,2 @@",
      "```",
    ].join("\n");
    const ASSISTANT_PROSE = "Got it — I'll remember that hunk.";

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          // l2 carries a real code marker (a diff hunk header on its own line)
          // so factMentionsCode fires, but it deliberately avoids a ``` fence —
          // a literal ``` inside the mocked LLM response collides with
          // extractMemories' own response-fence stripping. source_turn_index
          // mis-points at the assistant turn (1), which is not code-bearing, so
          // the neighbor scan recovers the user diff at idx-1 (turn 0).
          l2: "Recorded the invoice hunk.\n@@ -88,7 +88,10 @@",
          confidence: 0.95,
          source_turn_index: 1,
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: USER_DIFF_TURN },
        { role: "assistant", content: ASSISTANT_PROSE },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    expect(fact.raw_source_text).toBeDefined();
    // Recovered the user diff turn via the idx-1 neighbor scan, not the assistant turn.
    expect(fact.raw_source_text).toContain("```diff");
    expect(fact.raw_source_text).toContain("@@ -1,2 +1,2 @@");
    expect(fact.raw_source_text).not.toContain("Got it");
  });

  it("≥2-turns-away source: a mis-indexed non-code turn is left unstamped, not wrongly stamped (Rúnir-sm9k.2)", async () => {
    // The LLM points source_turn_index at the assistant analysis turn (2); the
    // real verbatim source (the user diff) is at turn 0 — two turns away,
    // outside the neighbor window. The fix must NOT stamp the non-code analysis
    // turn; it leaves raw_source_text undefined so the scorer's source_turn
    // path can recover, rather than silently locking in the wrong turn.
    const USER_DIFF_TURN = [
      "Here's the change:",
      "",
      "```diff",
      "@@ -1,2 +1,2 @@",
      "```",
    ].join("\n");
    const ASSISTANT_ACK = "Thanks, noted.";
    const ASSISTANT_ANALYSIS = "The change looks safe — it corrects the subtotal calc.";

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          l2: "Bug fix to the subtotal calculation.\n@@ -88,7 +88,10 @@",
          confidence: 0.95,
          source_turn_index: 2,
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: USER_DIFF_TURN },
        { role: "assistant", content: ASSISTANT_ACK },
        { role: "assistant", content: ASSISTANT_ANALYSIS },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    // No wrong stamp: must not be the non-code analysis or ack turn.
    expect(fact.raw_source_text ?? "").not.toContain("looks safe");
    expect(fact.raw_source_text ?? "").not.toContain("Thanks, noted");
    // Graceful degradation: left undefined (matches the missing-index policy).
    expect(fact.raw_source_text).toBeUndefined();
  });

  it("forward neighbor: user question then assistant code block recovers via idx+1 (Rúnir-sm9k.2)", async () => {
    const USER_QUESTION = "Can you show me the helper?";
    const ASSISTANT_CODE = [
      "Sure:",
      "",
      "```ts",
      "export const helper = () => 1;",
      "```",
    ].join("\n");

    mockFetch.mockResolvedValue(
      makeOpenRouterResponse([
        {
          // LLM mis-points at the non-code user question (0); the verbatim
          // source is the assistant code at idx+1.
          l2: "Assistant provided the helper.\n@@ -1 +1 @@",
          confidence: 0.95,
          source_turn_index: 0,
        },
      ]),
    );

    const facts = await extractMemories(
      [
        { role: "user", content: USER_QUESTION },
        { role: "assistant", content: ASSISTANT_CODE },
      ],
      "test prompt",
      "test-api-key",
    );

    expect(facts.length).toBe(1);
    const fact = facts[0]!;
    expect(fact.raw_source_text).toBeDefined();
    expect(fact.raw_source_text).toContain("```ts");
    expect(fact.raw_source_text).not.toContain("Can you show me");
  });
});
