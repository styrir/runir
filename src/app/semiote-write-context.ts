import type { MemoryWriteSource, SemioteProvenanceEnvelope, SemioteProvenanceSourceKind } from "../domain/memory/types.js";
import type { CanonicalContextIdentity } from "../identity/canonical-context.js";
import type { SemioteProvenanceBuildInput } from "../storage/surreal/phase2-store.js";

export type SemioteOriginContextInput = {
  identity: CanonicalContextIdentity;
  sourceKind: SemioteProvenanceSourceKind;
  writeSource: MemoryWriteSource;
  retrievalTraceId?: string;
  runirSessionId?: string;
  nativeSessionId?: string;
  sessionId?: string;
  path?: string;
  client?: string;
  extraction?: SemioteProvenanceEnvelope["extraction"];
};

export type SemioteOriginContext = {
  sessionId?: string;
  path?: string;
  client?: string;
  provenance: SemioteProvenanceBuildInput;
};

export function resolveSemioteOriginContext(
  input: SemioteOriginContextInput,
): SemioteOriginContext {
  const sessionId = input.identity.raw.sessionId ?? input.sessionId;
  const path = input.identity.raw.path ?? input.path;

  return {
    sessionId,
    path,
    client: input.client,
    provenance: {
      sourceKind: input.sourceKind,
      writeSource: input.writeSource,
      retrievalTraceId: input.retrievalTraceId,
      runirSessionId: input.runirSessionId,
      nativeSessionId: input.nativeSessionId,
      sessionId,
      path,
      client: input.client,
      extraction: input.extraction,
      identity: input.identity,
    },
  };
}
