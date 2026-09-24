import type { ThresholdsFile } from "./types.js";

export type UnlockLedgerEntry = {
  at: string;
  datasetId: string;
  split: "test";
  candidateId: string;
  candidateConfigHashes: string[];
  thresholdsHash: string;
};

export type TestGuardCommand = "run" | "score" | "calibrate";

export type TestGuardResult =
  | { ok: true; access: "exclude-test"; note: string }
  | { ok: true; access: "named-split"; note: string }
  | { ok: true; access: "unlocked"; note: string; thresholds: ThresholdsFile }
  | { ok: false; message: string };

/**
 * One guard for every command that would execute or score `split: test`.
 * Omitting `--split` excludes test rows. Calibrate never accepts them.
 * Test access requires `--unlock-test` and a sealed calibration thresholds file
 * for the same dataset and candidate.
 */
export function guardTestSplit(args: {
  command: TestGuardCommand;
  split: string | null;
  unlockTest: boolean;
  thresholds: ThresholdsFile | null;
  datasetId: string;
  candidateId: string;
  candidateConfigHash: string;
}): TestGuardResult {
  if (args.command === "calibrate") {
    if (args.split === "test") {
      return { ok: false, message: "calibrate refuses test rows and cannot execute or score split test" };
    }
    return {
      ok: true,
      access: "named-split",
      note: "Calibrate scores calibration rows only and refuses test rows.",
    };
  }
  if (args.split === null) {
    return {
      ok: true,
      access: "exclude-test",
      note: "Omitting --split excludes test rows and scores the non-test splits only.",
    };
  }
  if (args.split !== "test") {
    return { ok: true, access: "named-split", note: `Split ${args.split} does not include test rows.` };
  }
  if (!args.unlockTest) {
    return { ok: false, message: `${args.command} --split test refused: pass --unlock-test to record the peek` };
  }
  if (!args.thresholds) {
    return {
      ok: false,
      message: `${args.command} --split test refused: a sealed calibration thresholds file is required`,
    };
  }
  if (args.thresholds.datasetId !== args.datasetId) {
    return {
      ok: false,
      message: `${args.command} --split test refused: thresholds datasetId ${args.thresholds.datasetId} does not match ${args.datasetId}`,
    };
  }
  if (args.thresholds.split !== "calibration") {
    return { ok: false, message: `${args.command} --split test refused: thresholds split must be calibration` };
  }
  if (
    args.thresholds.candidateId !== args.candidateId
    || args.thresholds.candidateConfigHash !== args.candidateConfigHash
  ) {
    return { ok: false, message: `${args.command} --split test refused: thresholds file does not match this candidate config` };
  }
  return {
    ok: true,
    access: "unlocked",
    note: "Test split unlocked with the sealed calibration thresholds.",
    thresholds: args.thresholds,
  };
}

export function unlockLedgerLine(args: {
  at: string;
  datasetId: string;
  candidateId: string;
  candidateConfigHash: string;
  thresholds: ThresholdsFile;
}): string {
  const entry: UnlockLedgerEntry = {
    at: args.at,
    datasetId: args.datasetId,
    split: "test",
    candidateId: args.candidateId,
    candidateConfigHashes: [args.candidateConfigHash],
    thresholdsHash: args.thresholds.thresholdsHash,
  };
  return `${JSON.stringify(entry)}\n`;
}
