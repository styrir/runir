export interface DebugLogger {
  watermark(params: { session: string; prior: number; incoming: number; toProcess: number }): void;
  normalize(params: { session: string; count: number }): void;
  segmentation(params: { session: string; topics: number; titles: string }): void;
  factExtraction(params: { session: string; count: number; facts: Array<{ conf: number; text: string }> }): void;
  arbitrationOutcome(params: { session: string; outcome: string; text: string }): void;
  entityExtraction(params: { session: string; count: number; names: string }): void;
  entityOutcome(params: { session: string; name: string; outcome: string; err?: string }): void;
  recallResults(params: { session: string; query: string; count: number; topScore: number }): void;
  retrievalTrace(params: { session: string; summary: string }): void;
  salience(params: { session: string; score: number; hardOverride: boolean; reason: string }): void;
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) : s;
}

function fmt(key: string, value: string | number): string {
  if (typeof value === "number") return `${key}=${value}`;
  return `${key}="${truncate(value)}"`;
}

const noopLogger: DebugLogger = {
  watermark() {},
  normalize() {},
  segmentation() {},
  factExtraction() {},
  arbitrationOutcome() {},
  entityExtraction() {},
  entityOutcome() {},
  recallResults() {},
  retrievalTrace() {},
  salience() {},
};

export function makeDebugLogger(enabled: boolean, sink?: (line: string) => void): DebugLogger {
  if (!enabled) return noopLogger;

  const emit = sink ?? ((line: string) => console.log(line));

  return {
    watermark(p) {
      emit(`[debug] session-end: watermark  session=${p.session}  prior=${p.prior}  incoming=${p.incoming}  toProcess=${p.toProcess}`);
    },
    normalize(p) {
      emit(`[debug] session-end: normalize  session=${p.session}  count=${p.count}`);
    },
    segmentation(p) {
      emit(`[debug] session-end: segmentation  session=${p.session}  topics=${p.topics}  titles=${fmt("titles", p.titles).replace(/^titles=/, "")}`);
    },
    factExtraction(p) {
      const parts = [`[debug] session-end: facts  session=${p.session}  count=${p.count}`];
      for (let i = 0; i < Math.min(p.facts.length, 3); i++) {
        const f = p.facts[i]!;
        parts.push(`f${i}="${truncate(`${f.conf.toFixed(2)} ${f.text}`)}"`);
      }
      emit(parts.join("  "));
    },
    arbitrationOutcome(p) {
      emit(`[debug] session-end: arbitration  session=${p.session}  outcome=${p.outcome}  text="${truncate(p.text)}"`);
    },
    entityExtraction(p) {
      emit(`[debug] session-end: entities  session=${p.session}  count=${p.count}  names="${truncate(p.names)}"`);
    },
    entityOutcome(p) {
      if (p.err) {
        emit(`[debug] session-end: entity  session=${p.session}  name="${truncate(p.name)}"  outcome=${p.outcome}  err="${truncate(p.err)}"`);
      } else {
        emit(`[debug] session-end: entity  session=${p.session}  name="${truncate(p.name)}"  outcome=${p.outcome}`);
      }
    },
    recallResults(p) {
      emit(`[debug] recall: results  session=${p.session}  query="${truncate(p.query)}"  count=${p.count}  top=${p.topScore}`);
    },
    retrievalTrace(p) {
      emit(`[debug] recall: trace  session=${p.session}  ${p.summary}`);
    },
    salience(p) {
      emit(`[debug] capture: salience  session=${p.session}  score=${p.score}  hardOverride=${p.hardOverride}  reason="${truncate(p.reason)}"`);
    },
  };
}
