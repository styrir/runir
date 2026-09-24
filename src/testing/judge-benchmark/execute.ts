import { classifyOutcome, decideLane, headlineGold, jevQuestionFor, judgeInputViewFor, type FrozenCandidate } from "./candidates.js";
import {
  CassetteMissError,
  cassetteKey,
  cassetteLine,
  lookupCassette,
  parseCassette,
  readCassetteTelemetry,
  type CassetteEntry,
  type CassetteTelemetry,
} from "./cassette.js";
import { estimatePairUsd, isCallable, isProbeEligible, PROVIDER_ATTEMPT_LIMIT, worstCaseReservationUsd } from "./preflight.js";
import { isRecord } from "./schema.js";
import {
  JEV_MODEL_ID,
  JUDGE_BENCHMARK_SCHEMA_VERSION,
  REQUESTY_DECISIONS_BASE_URL,
  type JudgeBenchmarkRow,
  type JudgeSignals,
  type LoadedPair,
  type PairDirection,
  type TokenUsage,
} from "./types.js";
import type { JudgeInputView, JudgeOutcome } from "../../storage/writes/supersession-judge.js";

export class LaneCallError extends Error {
  readonly errorClass: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly auth: boolean;
  attempts = 1;
  constructor(errorClass: string, message: string, opts?: { httpStatus?: number; retryable?: boolean; auth?: boolean }) {
    super(message);
    this.name = "LaneCallError";
    this.errorClass = errorClass;
    this.httpStatus = opts?.httpStatus;
    this.retryable = opts?.retryable ?? false;
    this.auth = opts?.auth ?? false;
  }

  static fromStatus(status: number, source: "requesty" | "judge"): LaneCallError {
    const klass = httpClass(status);
    const message = source === "requesty" ? `requesty ${status}` : `judge ${klass.errorClass}`;
    return new LaneCallError(klass.errorClass, message, {
      httpStatus: status,
      retryable: klass.retryable,
      auth: klass.auth,
    });
  }
}

/** Integer micro-dollars so concurrent reservations cannot pass a cap on float dust. */
export class CostBudget {
  private committedMicros = 0;
  private inFlightMicros = 0;
  private highWaterMicros = 0;

  constructor(private readonly capUsd: number | null) {}

  private static micros(usd: number): number {
    return Math.round(usd * 1_000_000);
  }

  /** Synchronous check-and-add. Callers must not await between a successful reserve and recording it. */
  tryReserve(amountUsd: number): boolean {
    const amount = CostBudget.micros(amountUsd);
    const cap = this.capUsd === null ? null : CostBudget.micros(this.capUsd);
    if (cap !== null && this.committedMicros + this.inFlightMicros + amount > cap) return false;
    this.inFlightMicros += amount;
    this.note();
    return true;
  }

  reconcile(reservedUsd: number, actualUsd: number): void {
    const reserved = CostBudget.micros(reservedUsd);
    const actual = CostBudget.micros(Math.max(0, actualUsd));
    this.inFlightMicros = Math.max(0, this.inFlightMicros - reserved);
    this.committedMicros += actual;
    this.note();
  }

  private note(): void {
    this.highWaterMicros = Math.max(this.highWaterMicros, this.committedMicros + this.inFlightMicros);
  }

  get highWaterUsd(): number {
    return this.highWaterMicros / 1_000_000;
  }

  get cumulativeCostUsd(): number {
    return this.committedMicros / 1_000_000;
  }

  /** True once reconciled spend plus outstanding reservations has reached the cap. */
  capReached(): boolean {
    if (this.capUsd === null) return false;
    return this.committedMicros + this.inFlightMicros >= CostBudget.micros(this.capUsd);
  }
}

export type JudgeCaller = (oldText: string, newText: string) => Promise<JudgeOutcome>;
/**
 * Builds the judge for one input view. Injected factories receive the frozen
 * candidate's view, so a test double cannot silently record one candidate's
 * behaviour under another candidate's cassette key.
 */
export type JudgeFactory = (inputView: JudgeInputView) => JudgeCaller | Promise<JudgeCaller>;

export type ExecuteDeps = {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  judgeFor?: JudgeFactory;
  apiKey: string;
  appendCassette: (line: string) => void;
  cassetteText: string;
};

type PlannedCall = {
  item: LoadedPair;
  direction: PairDirection;
};

function usageFrom(body: unknown): { usage: TokenUsage; billedCostUsd: number | null } {
  if (!isRecord(body)) return { usage: {}, billedCostUsd: null };
  const usage = isRecord(body.usage) ? body.usage : {};
  const billed = [usage.cost, body.cost].find((value) => typeof value === "number" && Number.isFinite(value));
  return {
    usage: {
      ...(typeof usage.prompt_tokens === "number" ? { promptTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === "number" ? { completionTokens: usage.completion_tokens } : {}),
      ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    },
    billedCostUsd: typeof billed === "number" ? billed : null,
  };
}

function parseJevAnswer(content: unknown): Record<string, unknown> {
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new LaneCallError("invalid_response", "unrecognized Jev response shape");
    }
  }
  if (!isRecord(parsed)) throw new LaneCallError("invalid_response", "unrecognized Jev response shape");
  const nested = isRecord(parsed.answers) ? parsed.answers.q : undefined;
  const answer = nested ?? parsed.q;
  if (!isRecord(answer)) throw new LaneCallError("invalid_response", "unrecognized Jev response shape");
  return answer;
}

function signalsFromJev(candidate: FrozenCandidate, answer: Record<string, unknown>): JudgeSignals {
  if (candidate.family === "noul") {
    if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
      throw new LaneCallError("invalid_response", "Jev noul probability missing");
    }
    return { family: "noul", probability: answer.noul };
  }
  const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
  const pSupersede = typeof probabilities.supersede === "number" && Number.isFinite(probabilities.supersede)
    ? probabilities.supersede
    : null;
  const choice = answer.choice;
  if (choice !== "supersede" && choice !== "duplicate" && choice !== "independent") {
    throw new LaneCallError("invalid_response", "Jev choice missing");
  }
  return { family: "choice", argmax: choice, pSupersede };
}

function httpClass(status: number): { errorClass: string; retryable: boolean; auth: boolean } {
  if (status === 401 || status === 403) return { errorClass: "auth_failure", retryable: false, auth: true };
  if (status === 429) return { errorClass: "http_429", retryable: true, auth: false };
  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return { errorClass: `http_${status}`, retryable: true, auth: false };
  }
  return { errorClass: `http_${status}`, retryable: false, auth: false };
}

async function callJevOnce(
  item: LoadedPair,
  candidate: FrozenCandidate,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ signals: JudgeSignals; raw: string; usage: TokenUsage; billedCostUsd: number | null }> {
  const response = await fetchImpl(`${REQUESTY_DECISIONS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: JEV_MODEL_ID,
      messages: [{ role: "user", content: `OLD:\n${item.oldText}\n\nNEW:\n${item.newText}` }],
      response_format: { type: "questions", questions: { q: jevQuestionFor(candidate) } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw LaneCallError.fromStatus(response.status, "requesty");
  const body = (await response.json()) as unknown;
  const content = isRecord(body) ? body.choices && Array.isArray(body.choices)
    ? (body.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
    : undefined : undefined;
  const answer = parseJevAnswer(content);
  const priced = usageFrom(body);
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  return { signals: signalsFromJev(candidate, answer), raw, ...priced };
}

function judgeError(outcome: Exclude<JudgeOutcome, { status: "verdict" }>): LaneCallError {
  if (outcome.status === "unavailable") {
    return new LaneCallError("unavailable", "judge unavailable", { auth: true });
  }
  if (outcome.status === "invalid_response") {
    return new LaneCallError("invalid_response", "judge invalid_response");
  }
  const match = /LLM gateway error (\d{3})/u.exec(outcome.detail);
  const status = match ? Number(match[1]) : undefined;
  if (status !== undefined) return LaneCallError.fromStatus(status, "judge");
  return new LaneCallError("transport_error", "judge transport_error", { retryable: true });
}

async function withRetries<T>(
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<{ value: T; retryCount: number }> {
  let last: LaneCallError | null = null;
  for (let attempt = 0; attempt < PROVIDER_ATTEMPT_LIMIT; attempt += 1) {
    try {
      return { value: await run(), retryCount: attempt };
    } catch (error) {
      const wrapped = error instanceof LaneCallError
        ? error
        : new LaneCallError("transport_error", "transport_error", { retryable: true });
      wrapped.attempts = attempt + 1;
      last = wrapped;
      if (!wrapped.retryable || wrapped.auth || attempt === PROVIDER_ATTEMPT_LIMIT - 1) break;
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw last ?? new LaneCallError("transport_error", "transport_error");
}

function baseRow(args: {
  item: LoadedPair;
  candidate: FrozenCandidate;
  direction: PairDirection;
  runId: string;
  now: string;
  decision: ReturnType<typeof decideLane>;
  signals: JudgeSignals;
  latencyMs: number;
  retryCount: number;
  usage: TokenUsage;
  billedCostUsd: number | null;
  estimatedCostUsd: number | null;
  errorClass?: string;
  httpStatus?: number;
  datasetId: string;
}): JudgeBenchmarkRow {
  const pair = args.item.pair;
  const gold = headlineGold(pair);
  return {
    schemaVersion: JUDGE_BENCHMARK_SCHEMA_VERSION,
    runId: args.runId,
    timestamp: args.now,
    pairId: pair.pairId,
    datasetId: args.datasetId,
    candidateId: args.candidate.id,
    candidateConfigHash: args.candidate.candidateConfigHash,
    repetition: args.direction === "swapped" ? 2 : 1,
    direction: args.direction,
    split: pair.split,
    population: pair.population,
    stratum: pair.stratum,
    frame: pair.frame ?? null,
    legacyBinaryGold: pair.legacyBinaryGold === true,
    gold: {
      label: pair.gold.label,
      labelA: pair.gold.labelA,
      labelB: pair.gold.labelB,
      resolution: pair.gold.resolution,
      headline: gold,
      strict: pair.goldStrict ?? null,
    },
    oldRef: { id: pair.oldRef.id, sha256: pair.oldRef.sha256 },
    newRef: { id: pair.newRef.id, sha256: pair.newRef.sha256 },
    decision: args.decision.decision,
    effectiveDecision: args.decision.effectiveDecision,
    retireScore: args.decision.retireScore,
    signals: args.signals,
    outcome: classifyOutcome(gold, args.decision.effectiveDecision),
    latencyMs: args.latencyMs,
    retryCount: args.retryCount,
    usage: args.usage,
    billedCostUsd: args.billedCostUsd,
    estimatedCostUsd: args.estimatedCostUsd,
    ...(args.errorClass ? { errorClass: args.errorClass } : {}),
    ...(args.httpStatus !== undefined ? { httpStatus: args.httpStatus } : {}),
  };
}

function textsFor(item: LoadedPair, direction: PairDirection): { oldText: string; newText: string } {
  const oldText = direction === "swapped" ? item.newText ?? "" : item.oldText ?? "";
  const newText = direction === "swapped" ? item.oldText ?? "" : item.newText ?? "";
  return { oldText, newText };
}

function keyFor(candidate: FrozenCandidate, call: PlannedCall): string {
  return cassetteKey({
    candidateConfigHash: candidate.candidateConfigHash,
    ...textsFor(call.item, call.direction),
    direction: call.direction,
  });
}

export function planCalls(pairs: readonly LoadedPair[], probe: boolean): PlannedCall[] {
  const calls: PlannedCall[] = [];
  for (const item of pairs) calls.push({ item, direction: "forward" });
  if (!probe) return calls;
  for (const item of pairs) {
    if (!isProbeEligible(item)) continue;
    calls.push({ item, direction: "swapped" });
  }
  return calls;
}

export async function executeCalls(args: {
  pairs: readonly LoadedPair[];
  candidate: FrozenCandidate;
  probe: boolean;
  threshold: number;
  runId: string;
  datasetId: string;
  concurrency: number;
  maxTotalCostUsd: number | null;
  replayOnly: boolean;
  deps: ExecuteDeps;
}): Promise<{
  rows: JudgeBenchmarkRow[];
  cumulativeCostUsd: number;
  highWaterUsd: number;
  stopReason?: "cost_cap" | "auth_failure" | "runtime_error";
  providerFailures: number;
  providerCalls: number;
}> {
  const cassette = parseCassette(args.deps.cassetteText);
  const calls = planCalls(args.pairs, args.probe);
  const budget = new CostBudget(args.maxTotalCostUsd);
  if (args.replayOnly) {
    for (const call of calls) {
      if (!isCallable(call.item)) continue;
      readCassetteTelemetry(lookupCassette(cassette, args.candidate.id, keyFor(args.candidate, call)));
    }
  }
  const slots: Array<JudgeBenchmarkRow | undefined> = [];
  let stopReason: "cost_cap" | "auth_failure" | "runtime_error" | undefined;
  let providerFailures = 0;
  let providerCalls = 0;
  let cursor = 0;
  let reservedInFlight = 0;
  let version = 0;
  let waiters: Array<() => void> = [];
  let writeChain: Promise<void> = Promise.resolve();
  const enqueueWrite = (line: string): Promise<void> => {
    writeChain = writeChain.then(() => args.deps.appendCassette(line));
    return writeChain;
  };
  type SharedCall = { signals: JudgeSignals; telemetry: CassetteTelemetry };
  const inflight = new Map<string, Promise<SharedCall>>();
  const loadCall = (
    key: string,
    texts: { oldText: string; newText: string },
    oriented: LoadedPair,
    direction: PairDirection,
  ): { leader: boolean; promise: Promise<SharedCall> } => {
    const cached = cassette.get(key);
    if (cached) {
      return {
        leader: false,
        promise: Promise.resolve({ signals: cached.signals, telemetry: readCassetteTelemetry(cached) }),
      };
    }
    if (args.replayOnly) throw new CassetteMissError(args.candidate.id, key);
    const pending = inflight.get(key);
    if (pending) return { leader: false, promise: pending };
    const promise = (async (): Promise<SharedCall> => {
      providerCalls += 1;
      const started = Date.now();
      const attempt = await withRetries(async () => {
        if (args.candidate.family === "judge") {
          const view = judgeInputViewFor(args.candidate);
          const judge = args.deps.judgeFor ? await args.deps.judgeFor(view) : await defaultJudge(args.deps.apiKey, view);
          const outcome = await judge(texts.oldText, texts.newText);
          if (outcome.status !== "verdict") throw judgeError(outcome);
          return {
            signals: {
              family: "judge" as const,
              verdict: outcome.verdict.verdict,
              confidence: outcome.verdict.confidence,
            },
            raw: JSON.stringify({ verdict: outcome.verdict.verdict, confidence: outcome.verdict.confidence }),
            usage: {},
            billedCostUsd: null,
          };
        }
        return callJevOnce(oriented, args.candidate, args.deps.apiKey, args.deps.fetchImpl);
      }, args.deps.sleep);
      const perCall = estimatePairUsd(texts.oldText, texts.newText, args.candidate);
      const telemetry: CassetteTelemetry = {
        latencyMs: Date.now() - started,
        usage: attempt.value.usage,
        billedCostUsd: attempt.value.billedCostUsd,
        estimatedCostUsd: perCall * (attempt.retryCount + 1),
        retryCount: attempt.retryCount,
      };
      const entry: CassetteEntry = {
        key,
        candidateId: args.candidate.id,
        direction,
        signals: attempt.value.signals,
        raw: attempt.value.raw,
        ...telemetry,
      };
      cassette.set(key, entry);
      await enqueueWrite(cassetteLine(entry));
      return { signals: attempt.value.signals, telemetry };
    })();
    inflight.set(key, promise);
    void promise.then(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    }, () => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    return { leader: true, promise };
  };
  const wake = (): void => {
    version += 1;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const waitForChange = (seen: number): Promise<void> => {
    if (version !== seen) return Promise.resolve();
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  type Claim = { kind: "done" } | { kind: "blocked" } | { kind: "call"; index: number; reservation: number };
  const claim = (): Claim => {
    if (cursor >= calls.length) return { kind: "done" };
    const index = cursor;
    const call = calls[index]!;
    const callable = isCallable(call.item);
    let reservation = 0;
    if (callable && !args.replayOnly) {
      const texts = textsFor(call.item, call.direction);
      const key = keyFor(args.candidate, call);
      if (!cassette.get(key) && !inflight.has(key)) {
        reservation = worstCaseReservationUsd(texts.oldText, texts.newText, args.candidate);
        if (!budget.tryReserve(reservation)) return { kind: "blocked" };
        reservedInFlight += 1;
      }
    }
    cursor += 1;
    return { kind: "call", index, reservation };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopReason === "auth_failure" || stopReason === "cost_cap") return;
      const seen = version;
      const next = claim();
      if (next.kind === "done") return;
      if (next.kind === "blocked") {
        if (reservedInFlight === 0) {
          stopReason = "cost_cap";
          wake();
          return;
        }
        await waitForChange(seen);
        continue;
      }
      const call = calls[next.index]!;
      const reservation = next.reservation;
      let released = false;
      const release = (actual: number): void => {
        if (released) return;
        released = true;
        if (reservation <= 0) return;
        budget.reconcile(reservation, actual);
        reservedInFlight -= 1;
        if (stopReason !== "auth_failure" && budget.capReached()) stopReason = "cost_cap";
        wake();
      };
      const stamped = args.deps.now().toISOString();
      let startedAt: number | null = null;
      let perAttempt = 0;
      let leader = false;
      try {
        if (!isCallable(call.item)) {
          release(0);
          if (call.direction !== "forward") continue;
          const decision = decideLane(args.candidate, { family: "none" }, args.threshold);
          const row = baseRow({
            item: call.item,
            candidate: args.candidate,
            direction: "forward",
            runId: args.runId,
            now: stamped,
            decision,
            signals: { family: "none" },
            latencyMs: 0,
            retryCount: 0,
            usage: {},
            billedCostUsd: null,
            estimatedCostUsd: null,
            errorClass: call.item.caseError ?? "missing_text",
            datasetId: args.datasetId,
          });
          slots[next.index] = row;
          continue;
        }
        const texts = textsFor(call.item, call.direction);
        perAttempt = estimatePairUsd(texts.oldText, texts.newText, args.candidate);
        const oriented: LoadedPair = call.direction === "swapped"
          ? { ...call.item, oldText: texts.oldText, newText: texts.newText }
          : call.item;
        const key = keyFor(args.candidate, call);
        const shared = loadCall(key, texts, oriented, call.direction);
        leader = shared.leader;
        if (leader) startedAt = Date.now();
        const hit = await shared.promise;
        release(hit.telemetry.billedCostUsd ?? hit.telemetry.estimatedCostUsd ?? 0);
        const decision = decideLane(args.candidate, hit.signals, args.threshold);
        const row = baseRow({
          item: call.item,
          candidate: args.candidate,
          direction: call.direction,
          runId: args.runId,
          now: stamped,
          decision,
          signals: hit.signals,
          latencyMs: hit.telemetry.latencyMs,
          retryCount: hit.telemetry.retryCount,
          usage: hit.telemetry.usage,
          billedCostUsd: hit.telemetry.billedCostUsd,
          estimatedCostUsd: hit.telemetry.estimatedCostUsd,
          datasetId: args.datasetId,
        });
        slots[next.index] = row;
      } catch (error) {
        if (error instanceof CassetteMissError) {
          release(0);
          throw error;
        }
        const wrapped = error instanceof LaneCallError
          ? error
          : new LaneCallError("runtime_error", "runtime_error");
        if (leader) providerFailures += 1;
        if (wrapped.auth) stopReason = "auth_failure";
        release(perAttempt * wrapped.attempts);
        const decision = decideLane(args.candidate, null, args.threshold);
        const row = baseRow({
          item: call.item,
          candidate: args.candidate,
          direction: call.direction,
          runId: args.runId,
          now: stamped,
          decision,
          signals: { family: "none" },
          latencyMs: startedAt === null ? 0 : Date.now() - startedAt,
          retryCount: Math.max(0, wrapped.attempts - 1),
          usage: {},
          billedCostUsd: null,
          estimatedCostUsd: perAttempt * wrapped.attempts,
          errorClass: wrapped.errorClass,
          httpStatus: wrapped.httpStatus,
          datasetId: args.datasetId,
        });
        slots[next.index] = row;
        if (stopReason === "auth_failure") return;
      }
    }
  };

  const workers = Math.max(1, args.concurrency);
  await Promise.all(Array.from({ length: Math.min(workers, Math.max(calls.length, 1)) }, () => worker()));
  await writeChain;
  if (!stopReason && providerCalls > 0 && providerFailures === providerCalls) stopReason = "runtime_error";
  const rows = slots.filter((row): row is JudgeBenchmarkRow => row !== undefined);
  return {
    rows,
    cumulativeCostUsd: budget.cumulativeCostUsd,
    highWaterUsd: budget.highWaterUsd,
    stopReason,
    providerFailures,
    providerCalls,
  };
}

const constructed = new Map<string, { key: string; judge: JudgeCaller }>();

async function defaultJudge(apiKey: string, inputView: JudgeInputView): Promise<JudgeCaller> {
  const cached = constructed.get(inputView);
  if (cached?.key === apiKey) return cached.judge;
  const { buildSupersessionJudge } = await import("../../app/supersession-judge.js");
  const { DEFAULT_JUDGE_MODEL, DEFAULT_JUDGE_CONFIDENCE_FLOOR } = await import("../../storage/writes/supersession-judge.js");
  // baseUrl is passed explicitly: overriding RUNIR_LLM_BASE_URL across the
  // awaited imports raced when two lanes constructed judges concurrently.
  const handle = buildSupersessionJudge({
    apiKey,
    model: DEFAULT_JUDGE_MODEL,
    confidenceFloor: DEFAULT_JUDGE_CONFIDENCE_FLOOR,
    timeoutMs: 30_000,
    baseUrl: REQUESTY_DECISIONS_BASE_URL,
    inputView,
  });
  const judge: JudgeCaller = (oldText, newText) => handle.judge(oldText, newText);
  constructed.set(inputView, { key: apiKey, judge });
  return judge;
}
