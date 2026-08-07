import {
  assessReviewCompatibility,
  compareReviewRuns,
  type CompareReviewRunsOptions,
} from "../../src/testing/review-studio/benchmark-adapter.js";
import { adaptReviewRun } from "../../src/testing/review-studio/adapter-registry.js";
import type {
  BenchmarkRunBundle,
  ReviewCaseResult,
  ReviewComparison,
  ReviewDiagnostic,
  ReviewRawEvidence,
  ReviewRun,
} from "../../src/testing/review-studio/types.js";
import { readFileSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_MANIFEST_BYTES = 1_000_000;
const DEFAULT_MAX_JSONL_BYTES = 32_000_000;
const DEFAULT_MAX_ROW_BYTES = 1_000_000;
const DEFAULT_MAX_ROWS = 20_000;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 2_000;

export type ReviewArtifactRoot = {
  readonly path: string;
  readonly label?: string;
};

export type ReviewCatalogLimits = {
  readonly maxManifestBytes?: number;
  readonly maxJsonlBytes?: number;
  readonly maxRowBytes?: number;
  readonly maxRows?: number;
  readonly maxDepth?: number;
  readonly maxFiles?: number;
};

export type ReviewCatalogDiagnostic = ReviewDiagnostic & {
  readonly rootLabel?: string;
  readonly relativePath?: string;
};

export type ReviewArtifactDescriptor = {
  readonly rootLabel: string;
  readonly relativeManifest: string;
  readonly relativeRows: string;
  readonly manifestBytes: number;
  readonly rowsBytes: number;
  readonly loadedRows: number;
};

export type ReviewCatalogRun = {
  readonly catalogId: string;
  readonly run: ReviewRun;
  readonly artifact: ReviewArtifactDescriptor;
};

export type ReviewCatalogSnapshot = {
  readonly generatedAt: string;
  readonly runs: readonly ReviewCatalogRun[];
  readonly duplicateRunIds: readonly string[];
  readonly diagnostics: readonly ReviewCatalogDiagnostic[];
};

export type ReviewCatalogOptions = {
  readonly roots: readonly (string | ReviewArtifactRoot)[];
  readonly limits?: ReviewCatalogLimits;
  readonly now?: () => Date;
};

type ResolvedRoot = {
  readonly absolutePath: string;
  readonly label: string;
};

type ArtifactCandidate = {
  readonly root: ResolvedRoot;
  readonly manifestPath: string;
  readonly rowsPath: string;
  readonly relativeManifest: string;
  readonly relativeRows: string;
};

type LoadedBundle = {
  readonly bundle: BenchmarkRunBundle;
  readonly artifact: ReviewArtifactDescriptor;
};

type DiagnosticSink = (diagnostic: ReviewCatalogDiagnostic) => void;

function diagnostic(
  sink: DiagnosticSink,
  code: string,
  message: string,
  severity: ReviewDiagnostic["severity"],
  context: Pick<ReviewCatalogDiagnostic, "rootLabel" | "relativePath"> = {},
): void {
  sink({ code, message, severity, ...context });
}

function hasTraversalSegment(rawPath: string): boolean {
  return rawPath.split(/[\\/]+/u).some((segment) => segment === "..");
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../"));
}

function relativePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function resolveRoots(
  roots: readonly (string | ReviewArtifactRoot)[],
  sink: DiagnosticSink,
): ResolvedRoot[] {
  const seen = new Set<string>();
  const resolved: ResolvedRoot[] = [];
  for (const entry of roots) {
    const rawPath = typeof entry === "string" ? entry : entry.path;
    const label = typeof entry === "string" ? undefined : entry.label;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      diagnostic(sink, "invalid_root", "Artifact root must be a non-empty path.", "error");
      continue;
    }
    if (hasTraversalSegment(rawPath)) {
      diagnostic(sink, "root_traversal_rejected", "Artifact root contains a traversal segment and was rejected.", "error", {
        relativePath: rawPath,
      });
      continue;
    }

    const absolutePath = resolve(rawPath);
    let rootStat;
    try {
      rootStat = lstatSync(absolutePath);
    } catch {
      diagnostic(sink, "root_unreadable", "Artifact root does not exist or cannot be inspected.", "error", {
        relativePath: rawPath,
      });
      continue;
    }
    if (rootStat.isSymbolicLink()) {
      diagnostic(sink, "symlink_root_rejected", "Symbolic-link roots are rejected; provide a real directory.", "error", {
        relativePath: rawPath,
      });
      continue;
    }
    if (!rootStat.isDirectory()) {
      diagnostic(sink, "root_not_directory", "Artifact root must be a directory.", "error", { relativePath: rawPath });
      continue;
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(absolutePath);
    } catch {
      diagnostic(sink, "root_unreadable", "Artifact root could not be resolved safely.", "error", { relativePath: rawPath });
      continue;
    }
    if (seen.has(realRoot)) continue;
    seen.add(realRoot);
    resolved.push({ absolutePath: realRoot, label: label?.trim() || basename(realRoot) });
  }
  return resolved;
}

function walkRoot(
  root: ResolvedRoot,
  limits: Required<ReviewCatalogLimits>,
  sink: DiagnosticSink,
): string[] {
  const files: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (files.length >= limits.maxFiles) return;
    if (depth > limits.maxDepth) {
      diagnostic(sink, "max_depth_exceeded", "Artifact root exceeded the configured scan depth.", "warning", {
        rootLabel: root.label,
        relativePath: relativePath(root.absolutePath, current),
      });
      return;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      diagnostic(sink, "directory_unreadable", "A directory could not be read; the catalog skipped it.", "warning", {
        rootLabel: root.label,
        relativePath: relativePath(root.absolutePath, current),
      });
      return;
    }

    for (const entry of entries) {
      if (files.length >= limits.maxFiles) break;
      const child = resolve(current, entry.name);
      const childRelative = relativePath(root.absolutePath, child);
      if (!pathWithin(root.absolutePath, child)) {
        diagnostic(sink, "path_escape_rejected", "A discovered path escaped the explicit artifact root.", "error", {
          rootLabel: root.label,
          relativePath: childRelative,
        });
        continue;
      }
      if (entry.isSymbolicLink()) {
        diagnostic(sink, "symlink_escape_rejected", "Symbolic-link artifacts are rejected by the catalog boundary.", "error", {
          rootLabel: root.label,
          relativePath: childRelative,
        });
        continue;
      }
      if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };

  walk(root.absolutePath, 0);
  if (files.length >= limits.maxFiles) {
    diagnostic(sink, "max_files_exceeded", "The artifact root reached the configured file cap.", "warning", {
      rootLabel: root.label,
    });
  }
  return files;
}

function readBounded(path: string, maxBytes: number): { text?: string; bytes: number; error?: "oversized" | "unreadable" } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { bytes: 0, error: "unreadable" };
  }
  if (!Number.isSafeInteger(size) || size > maxBytes) return { bytes: size, error: "oversized" };
  try {
    return { text: readFileSync(path, "utf8"), bytes: size };
  } catch {
    return { bytes: size, error: "unreadable" };
  }
}

function parseJsonl(
  raw: string,
  artifact: ArtifactCandidate,
  limits: Required<ReviewCatalogLimits>,
  sink: DiagnosticSink,
): unknown[] {
  const rows: unknown[] = [];
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > limits.maxRowBytes) {
      diagnostic(sink, "row_oversized", "An oversized JSONL row was skipped without reading beyond the row cap.", "warning", {
        rootLabel: artifact.root.label,
        relativePath: artifact.relativeRows,
      });
      continue;
    }
    if (rows.length >= limits.maxRows) {
      diagnostic(sink, "max_rows_exceeded", "Additional JSONL rows were skipped after the configured row cap.", "warning", {
        rootLabel: artifact.root.label,
        relativePath: artifact.relativeRows,
      });
      break;
    }
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch {
      diagnostic(sink, "malformed_jsonl", `Malformed JSONL row ${index + 1} was skipped.`, "warning", {
        rootLabel: artifact.root.label,
        relativePath: artifact.relativeRows,
      });
    }
  }
  return rows;
}

function discoverArtifacts(
  root: ResolvedRoot,
  limits: Required<ReviewCatalogLimits>,
  sink: DiagnosticSink,
): ArtifactCandidate[] {
  const files = walkRoot(root, limits, sink);
  const byPath = new Set(files);
  return files
    .filter((manifestPath) => manifestPath.endsWith(".manifest.json"))
    .sort()
    .flatMap((manifestPath) => {
      const rowsPath = manifestPath.replace(/\.manifest\.json$/u, ".jsonl");
      if (!byPath.has(rowsPath)) {
        diagnostic(sink, "missing_rows_artifact", "Manifest has no matching JSONL rows artifact.", "warning", {
          rootLabel: root.label,
          relativePath: relativePath(root.absolutePath, manifestPath),
        });
        return [];
      }
      return [{
        root,
        manifestPath,
        rowsPath,
        relativeManifest: relativePath(root.absolutePath, manifestPath),
        relativeRows: relativePath(root.absolutePath, rowsPath),
      }];
    });
}

function loadBundle(
  artifact: ArtifactCandidate,
  limits: Required<ReviewCatalogLimits>,
  sink: DiagnosticSink,
): LoadedBundle | undefined {
  const manifestRead = readBounded(artifact.manifestPath, limits.maxManifestBytes);
  if (manifestRead.error !== undefined || manifestRead.text === undefined) {
    diagnostic(
      sink,
      manifestRead.error === "oversized" ? "manifest_oversized" : "manifest_unreadable",
      manifestRead.error === "oversized"
        ? "An oversized manifest was ignored before JSON parsing."
        : "A manifest could not be read and was ignored.",
      "warning",
      { rootLabel: artifact.root.label, relativePath: artifact.relativeManifest },
    );
    return undefined;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRead.text) as unknown;
  } catch {
    diagnostic(sink, "malformed_manifest", "Malformed manifest JSON was ignored without crashing the catalog.", "warning", {
      rootLabel: artifact.root.label,
      relativePath: artifact.relativeManifest,
    });
    return undefined;
  }

  const rowsRead = readBounded(artifact.rowsPath, limits.maxJsonlBytes);
  if (rowsRead.error !== undefined || rowsRead.text === undefined) {
    diagnostic(
      sink,
      rowsRead.error === "oversized" ? "jsonl_oversized" : "jsonl_unreadable",
      rowsRead.error === "oversized"
        ? "An oversized JSONL artifact was ignored before parsing."
        : "A JSONL artifact could not be read and was ignored.",
      "warning",
      { rootLabel: artifact.root.label, relativePath: artifact.relativeRows },
    );
    return undefined;
  }

  const rows = parseJsonl(rowsRead.text, artifact, limits, sink);
  return {
    bundle: { manifest, rows, sourceRoot: artifact.root.label },
    artifact: {
      rootLabel: artifact.root.label,
      relativeManifest: artifact.relativeManifest,
      relativeRows: artifact.relativeRows,
      manifestBytes: manifestRead.bytes,
      rowsBytes: rowsRead.bytes,
      loadedRows: rows.length,
    },
  };
}

function requiredLimits(limits: ReviewCatalogLimits | undefined): Required<ReviewCatalogLimits> {
  return {
    maxManifestBytes: limits?.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
    maxJsonlBytes: limits?.maxJsonlBytes ?? DEFAULT_MAX_JSONL_BYTES,
    maxRowBytes: limits?.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
    maxRows: limits?.maxRows ?? DEFAULT_MAX_ROWS,
    maxDepth: limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFiles: limits?.maxFiles ?? DEFAULT_MAX_FILES,
  };
}

function runIdFor(run: ReviewRun): string {
  return run.runId || "(missing-run-id)";
}

function addAdaptationDiagnostic(
  sink: DiagnosticSink,
  error: unknown,
  artifact: ReviewArtifactDescriptor,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "invalid_bundle";
  diagnostic(sink, code, `Artifact ignored: ${message}`, "warning", {
    rootLabel: artifact.rootLabel,
    relativePath: artifact.relativeManifest,
  });
}

function buildSnapshot(options: ReviewCatalogOptions): ReviewCatalogSnapshot {
  const diagnostics: ReviewCatalogDiagnostic[] = [];
  const sink: DiagnosticSink = (item) => diagnostics.push(item);
  const limits = requiredLimits(options.limits);
  const roots = resolveRoots(options.roots, sink);
  const loaded: LoadedBundle[] = roots
    .flatMap((root) => discoverArtifacts(root, limits, sink))
    .sort((a, b) => {
      const left = `${a.root.label}/${a.relativeManifest}`;
      const right = `${b.root.label}/${b.relativeManifest}`;
      return left.localeCompare(right);
    })
    .map((candidate) => loadBundle(candidate, limits, sink))
    .filter((item): item is LoadedBundle => item !== undefined);

  const adapted: ReviewCatalogRun[] = [];
  for (const item of loaded) {
    try {
      const run = adaptReviewRun(item.bundle);
      adapted.push({
        catalogId: "",
        run,
        artifact: item.artifact,
      });
    } catch (error) {
      addAdaptationDiagnostic(sink, error, item.artifact);
    }
  }

  const counts = new Map<string, number>();
  for (const item of adapted) counts.set(runIdFor(item.run), (counts.get(runIdFor(item.run)) ?? 0) + 1);
  const duplicateRunIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([runId]) => runId)
    .sort();
  for (const runId of duplicateRunIds) {
    diagnostic(sink, "duplicate_run_id", `Duplicate runId ${runId} found across explicit artifact roots; no run was discarded.`, "error");
  }

  const runs = adapted.map((item, index) => ({
    ...item,
    catalogId: `catalog-${index + 1}`,
  }));
  const now = options.now ?? (() => new Date());
  return {
    generatedAt: now().toISOString(),
    runs,
    duplicateRunIds,
    diagnostics,
  };
}

/**
 * Rebuildable read-only catalog. It keeps no index on disk and never mutates
 * the explicit artifact roots passed to it.
 */
export class ReviewCatalog {
  readonly #options: ReviewCatalogOptions;
  #snapshot: ReviewCatalogSnapshot;

  constructor(options: ReviewCatalogOptions) {
    this.#options = { ...options, roots: [...options.roots] };
    this.#snapshot = buildSnapshot(this.#options);
  }

  get snapshot(): ReviewCatalogSnapshot {
    return this.#snapshot;
  }

  refresh(): ReviewCatalogSnapshot {
    this.#snapshot = buildSnapshot(this.#options);
    return this.#snapshot;
  }

  findRun(catalogId: string): ReviewCatalogRun | undefined {
    return this.#snapshot.runs.find((item) => item.catalogId === catalogId);
  }

  findCase(catalogId: string, comparisonKey: string): {
    readonly record: ReviewCatalogRun;
    readonly result: ReviewCaseResult;
  } | undefined {
    const record = this.findRun(catalogId);
    if (!record) return undefined;
    const result = record.run.cases.find((item) => item.comparisonKey === comparisonKey);
    return result ? { record, result } : undefined;
  }

  rawEvidence(catalogId: string, comparisonKey: string): ReviewRawEvidence | undefined {
    return this.findCase(catalogId, comparisonKey)?.result.rawEvidence;
  }

  compare(
    baselineId: string,
    candidateId: string,
    options: CompareReviewRunsOptions = {},
  ): ReviewComparison {
    const baseline = this.findRun(baselineId);
    const candidate = this.findRun(candidateId);
    if (!baseline || !candidate) {
      throw new Error("Both baseline and candidate catalog IDs are required.");
    }
    return compareReviewRuns(baseline.run, candidate.run, options);
  }

  compatibility(baselineId: string, candidateId: string) {
    const baseline = this.findRun(baselineId);
    const candidate = this.findRun(candidateId);
    if (!baseline || !candidate) return undefined;
    return assessReviewCompatibility(baseline.run, candidate.run);
  }
}

export function createReviewCatalog(options: ReviewCatalogOptions): ReviewCatalog {
  return new ReviewCatalog(options);
}

export function isSafeComparisonKey(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isSafeCatalogId(value: string): boolean {
  return /^catalog-[1-9][0-9]*$/u.test(value);
}

export function summarizeDiagnostic(diagnosticItem: ReviewCatalogDiagnostic): string {
  return [diagnosticItem.code, diagnosticItem.message, diagnosticItem.rootLabel, diagnosticItem.relativePath]
    .filter(Boolean)
    .join(" | ");
}
