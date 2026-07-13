// Canonical v1.5 fit-distribution fixture for Hexis Phase 3a magnitude parity.
// v15Boost captures the pre-calibration formula: fit * hexisMatch * 0.25.
// Fits are concentrated in the [0.2, 0.8] mid-band where the sigmoid shape
// diverges most from identity. Entries are intentionally ordered by fit
// ascending so tests can reason about rank preservation directly.

export interface HexisV15FitEntry {
  id: string;
  fit: number;
  hexisMatch: number;
  v15Boost: number;
}

function v15(fit: number, hexisMatch: number): number {
  return fit * hexisMatch * 0.25;
}

const raw: Array<{ id: string; fit: number; hexisMatch: number }> = [
  { id: "v15-00", fit: 0.00, hexisMatch: 1.0 },
  { id: "v15-01", fit: 0.10, hexisMatch: 1.0 },
  { id: "v15-02", fit: 0.20, hexisMatch: 1.0 },
  { id: "v15-03", fit: 0.25, hexisMatch: 1.0 },
  { id: "v15-04", fit: 0.30, hexisMatch: 1.0 },
  { id: "v15-05", fit: 0.35, hexisMatch: 1.0 },
  { id: "v15-06", fit: 0.40, hexisMatch: 1.0 },
  { id: "v15-07", fit: 0.45, hexisMatch: 1.0 },
  { id: "v15-08", fit: 0.50, hexisMatch: 1.0 },
  { id: "v15-09", fit: 0.55, hexisMatch: 1.0 },
  { id: "v15-10", fit: 0.60, hexisMatch: 1.0 },
  { id: "v15-11", fit: 0.65, hexisMatch: 1.0 },
  { id: "v15-12", fit: 0.70, hexisMatch: 1.0 },
  { id: "v15-13", fit: 0.75, hexisMatch: 1.0 },
  { id: "v15-14", fit: 0.80, hexisMatch: 1.0 },
  { id: "v15-15", fit: 0.85, hexisMatch: 1.0 },
  { id: "v15-16", fit: 0.90, hexisMatch: 1.0 },
  { id: "v15-17", fit: 1.00, hexisMatch: 1.0 },
  { id: "v15-18", fit: 0.42, hexisMatch: 0.7 },
  { id: "v15-19", fit: 0.68, hexisMatch: 0.7 },
];

export const hexisV15FitDistribution: HexisV15FitEntry[] = raw.map((entry) => ({
  ...entry,
  v15Boost: v15(entry.fit, entry.hexisMatch),
}));
