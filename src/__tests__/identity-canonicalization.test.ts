import { describe, it, expect } from "vitest";
import { canonicalizeFactKey } from "../capture/extraction/capture.js";

describe("canonicalizeFactKey", () => {
  it("returns profile:name when category=profile and text matches name pattern", () => {
    const fact = {
      l2: "User's name is Brooks",
      l0: "User Profile: name is Brooks",
      l1: "",
      confidence: 0.95,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:user-name-brooks-abc123",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:name");
  });

  it("returns profile:name for 'my name' pattern", () => {
    const fact = {
      l2: "My name is Alice",
      l0: "User name: Alice",
      l1: "",
      confidence: 0.95,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:user-name-alice-def456",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:name");
  });

  it("returns profile:name for 'called' pattern", () => {
    const fact = {
      l2: "I'm called Charlie",
      l0: "User called Charlie",
      l1: "",
      confidence: 0.9,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:called-charlie-aaa111",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:name");
  });

  it("returns preferences:addressing for 'call me' pattern", () => {
    const fact = {
      l2: "Please call me Dr. Smith",
      l0: "Addressing preference: Dr. Smith",
      l1: "",
      confidence: 0.9,
      category: "preferences" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "preferences:call-me-dr-smith-bbb222",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("preferences:addressing");
  });

  it("returns preferences:addressing for 'address me' pattern", () => {
    const fact = {
      l2: "Address me as Professor Jones",
      l0: "Addressing: Professor Jones",
      l1: "",
      confidence: 0.9,
      category: "preferences" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "preferences:address-me-prof-ccc333",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("preferences:addressing");
  });

  it("returns preferences:addressing for 'don't call me' pattern", () => {
    const fact = {
      l2: "Don't call me buddy",
      l0: "Don't call user buddy",
      l1: "",
      confidence: 0.9,
      category: "preferences" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "preferences:dont-call-buddy-ddd444",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("preferences:addressing");
  });

  it("returns profile:role for 'I am a' pattern", () => {
    const fact = {
      l2: "I am a senior backend engineer",
      l0: "User is senior backend engineer",
      l1: "",
      confidence: 0.95,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:senior-backend-eng-eee555",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:role");
  });

  it("returns profile:role for 'my job' pattern", () => {
    const fact = {
      l2: "My job is software development",
      l0: "User job: software development",
      l1: "",
      confidence: 0.9,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:job-software-fff666",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:role");
  });

  it("returns preferences:language for 'I prefer' coding language pattern", () => {
    const fact = {
      l2: "I prefer TypeScript for backend work",
      l0: "User prefers TypeScript",
      l1: "",
      confidence: 0.9,
      category: "preferences" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "preferences:prefer-typescript-ggg777",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("preferences:language");
  });

  it("returns preferences:language for 'i code in' pattern", () => {
    const fact = {
      l2: "I code in Go and Rust mostly",
      l0: "User codes in Go and Rust",
      l1: "",
      confidence: 0.9,
      category: "preferences" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "preferences:code-go-rust-hhh888",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("preferences:language");
  });

  it("preserves original factKey when no pattern matches", () => {
    const fact = {
      l2: "The server runs on port 7700",
      l0: "Server port: 7700",
      l1: "",
      confidence: 0.9,
      category: "profile" as const,
      tier: "durable" as const,
      tags: [],
      factKey: "profile:server-port-7700-iii999",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("profile:server-port-7700-iii999");
  });

  it("preserves original factKey for non-profile/preferences categories", () => {
    const fact = {
      l2: "My name is Brooks but this is an event",
      l0: "Name mention in event",
      l1: "",
      confidence: 0.9,
      category: "events" as const,
      tier: "working" as const,
      tags: [],
      factKey: "events:name-mention-jjj000",
    };
    const result = canonicalizeFactKey(fact);
    expect(result.factKey).toBe("events:name-mention-jjj000");
  });
});
