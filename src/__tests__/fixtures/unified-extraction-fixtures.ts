export type UnifiedExtractionFixture = {
  id: string;
  description: string;
  sessionTimestamp?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  expected: {
    facts: number;
    categories?: string[];
    requiredContains?: string[];
    forbiddenContains?: string[];
    requiredTags?: string[];
    sourceTurnIndex?: number;
    abstains?: boolean;
  };
};

export const unifiedExtractionFixtures: UnifiedExtractionFixture[] = [
  {
    id: "mixed-developer-personal",
    description: "One prompt captures developer/project and personal preference facts in the same session.",
    messages: [
      {
        role: "user",
        content: "For Runir, remember that the extractor must preserve exact SurrealQL snippets. Also, personally, I hate 90-day plans; use agentic non-calendar planning instead.",
      },
      {
        role: "assistant",
        content: "That means exact query text should survive in memory rather than being paraphrased away.",
      },
    ],
    expected: {
      facts: 2,
      categories: ["preferences", "patterns"],
      requiredContains: ["Runir", "SurrealQL", "90-day", "agentic non-calendar"],
      forbiddenContains: ["generic planning advice"],
      requiredTags: ["speaker:user", "owner:user", "subject:runir"],
    },
  },
  {
    id: "social-speaker-subject-owner",
    description: "Third-party social statement must not be rewritten as the user's belief.",
    messages: [
      {
        role: "user",
        content: "Sadia keeps saying women who like older men must be traumatized. I do not agree with that.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["entities", "events"],
      requiredContains: ["Sadia", "User does not agree"],
      forbiddenContains: ["User believes women who like older men must be traumatized"],
      requiredTags: ["speaker:user", "owner:user", "subject:sadia"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "user-diff-source-turn",
    description: "A user-pasted diff remains sourced to the user turn even when the assistant provides the analysis.",
    messages: [
      {
        role: "user",
        content: [
          "Here is the diff I'm about to merge:",
          "",
          "```diff",
          "--- a/src/billing/invoice-generator.ts",
          "+++ b/src/billing/invoice-generator.ts",
          "@@ -88,7 +88,10 @@ export async function generateInvoice(",
          "-  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);",
          "+  const subtotal = lineItems.reduce(",
          "+    (sum, li) => sum + li.amount * (li.quantity ?? 1),",
          "+    0,",
          "+  );",
          "```",
        ].join("\n"),
      },
      {
        role: "assistant",
        content: "This fixes orders with multi-unit line items by multiplying amount by quantity.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["cases"],
      requiredContains: ["src/billing/invoice-generator.ts", "generateInvoice", "li.quantity"],
      requiredTags: ["speaker:user", "diff"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "list-preservation",
    description: "Ordered project constraints stay list-shaped instead of collapsing into vague prose.",
    messages: [
      {
        role: "user",
        content: "For Leit, the non-negotiables are:\n1. No hidden ownership\n2. No implicit coupling across projects\n3. Namespaces must be durable and enforceable\n4. Avoid central bottlenecks unless justified",
      },
    ],
    expected: {
      facts: 1,
      categories: ["preferences", "patterns"],
      requiredContains: ["Leit", "No hidden ownership", "Namespaces must be durable"],
      requiredTags: ["project:leit", "list", "constraints"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "negative-update-invalidation",
    description: "A later correction becomes current truth and marks the older state invalid.",
    messages: [
      { role: "user", content: "We are using Redis for this prototype." },
      {
        role: "user",
        content: "Update: we are no longer using Redis. Dragonfly is the replacement because the latency profile is better.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["entities"],
      requiredContains: ["Dragonfly", "Redis", "latency profile"],
      requiredTags: ["update", "negative", "invalidation", "subject:redis", "subject:dragonfly"],
      sourceTurnIndex: 1,
    },
  },
  {
    id: "relative-date-event",
    description: "Relative dates are normalized against the session timestamp while preserving the original phrase.",
    sessionTimestamp: "2026-05-19T12:00:00-04:00",
    messages: [
      {
        role: "user",
        content: "Yesterday I sent Rokid my Tallinn address and asked them to ship the glasses ASAP, with lenses sent later unless they finish within a week.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["events"],
      requiredContains: ["2026-05-18", "Rokid", "Tallinn", "within a week"],
      requiredTags: ["temporal:2026-05-18", "owner:user", "subject:rokid"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "avoidance-directive",
    description: "Explicit communication avoidance creates a preference and optional directive.",
    messages: [
      { role: "user", content: "No counseling. When I ask what DBT means, just explain the term." },
    ],
    expected: {
      facts: 1,
      categories: ["preferences"],
      requiredContains: ["No counseling", "DBT", "explain the term"],
      requiredTags: ["speaker:user", "owner:user", "negative", "do_not", "communication-style"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "procedural-developer-pattern",
    description: "Developer procedures preserve exact query artifacts and ordered debugging steps.",
    messages: [
      {
        role: "user",
        content: "When debugging SurrealDB BM25 in Runir, first test whether text_norm @1@ query matches rows, then separately verify search::score(1). We saw matches with score 0 on 3.0.4.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["patterns"],
      requiredContains: ["text_norm @1@", "search::score(1)", "3.0.4"],
      requiredTags: ["technical", "surrealdb", "bm25", "project:runir", "procedure"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "assistant-originated-diagnosis",
    description: "Assistant-originated project diagnosis is storable when it is the reusable fact.",
    messages: [
      { role: "user", content: "Why is the opener missing the blocker?" },
      {
        role: "assistant",
        content: "The issue is not Hexis. The seed lacks blocker aliases like 'auth migration is blocked' and 'blocked on JWT_EXPIRY', so retrieval misses the status-continuity shape.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["cases"],
      requiredContains: ["not Hexis", "blocked on JWT_EXPIRY", "status-continuity"],
      requiredTags: ["speaker:assistant", "subject:runir", "retrieval", "negative"],
      sourceTurnIndex: 1,
    },
  },
  {
    id: "generic-explanation-abstention",
    description: "Generic explanations abstain when not tied to the user or project.",
    messages: [
      { role: "user", content: "What is the difference between semantic and episodic memory?" },
      { role: "assistant", content: "Semantic memory stores facts; episodic memory stores experiences." },
    ],
    expected: {
      facts: 0,
      abstains: true,
    },
  },
  {
    id: "generic-explanation-project-fact",
    description: "The same concept becomes memory when explicitly tied to Runir design.",
    messages: [
      {
        role: "user",
        content: "For Runir, map semantic memory to Noema, episodic memory to Semiotes/events, and procedural memory to patterns/directives.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["entities", "patterns"],
      requiredContains: ["Runir", "Noema", "Semiotes/events", "patterns/directives"],
      requiredTags: ["project:runir", "semantic", "episodic", "procedural"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "multi-session-synthesis-single-source",
    description: "Cross-session synthesis keeps source_turn_index single-valued and points at the decisive current instruction.",
    messages: [
      { role: "user", content: "My Estonian address is Test Fixture, 123 Memory Lane, Unit 7, 10133 Tallinn, Estonia." },
      { role: "user", content: "Use my Tallinn address for Rokid shipping." },
    ],
    expected: {
      facts: 1,
      categories: ["events", "entities"],
      requiredContains: ["Rokid", "Tallinn address"],
      forbiddenContains: ["source_turn_index: ["],
      requiredTags: ["support:prior_address", "subject:rokid", "owner:user"],
      sourceTurnIndex: 1,
    },
  },
  {
    id: "premise-invalidating-answer",
    description: "Assistant corrections do not become false user beliefs.",
    messages: [
      { role: "user", content: "Is this a progressive lens?" },
      { role: "assistant", content: "No, this appears to be a single-vision digital lens, not a progressive lens." },
    ],
    expected: {
      facts: 1,
      categories: ["cases", "entities"],
      requiredContains: ["assistant clarified", "not progressive", "single-vision digital lens"],
      forbiddenContains: ["User believes it is progressive"],
      requiredTags: ["speaker:assistant", "negative", "lens", "premise_invalidated"],
      sourceTurnIndex: 1,
    },
  },
  {
    id: "exact-url-repo-artifact",
    description: "URLs, repo names, and source paths are preserved exactly.",
    messages: [
      {
        role: "user",
        content: "This is related to https://github.com/AlphaComposite/runir and the extractor prompt lives in src/domain/memory/prompts.ts.",
      },
    ],
    expected: {
      facts: 1,
      categories: ["entities"],
      requiredContains: ["https://github.com/AlphaComposite/runir", "src/domain/memory/prompts.ts"],
      requiredTags: ["repo:alphacomposite/runir", "technical", "source_path", "speaker:user"],
      sourceTurnIndex: 0,
    },
  },
  {
    id: "small-talk-overextraction-guard",
    description: "Small talk remains an abstention case.",
    messages: [
      { role: "user", content: "Good morning." },
      { role: "assistant", content: "Good morning. How can I help?" },
    ],
    expected: {
      facts: 0,
      abstains: true,
    },
  },
];
