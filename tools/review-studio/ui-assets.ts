import { readFileSync } from "node:fs";
import { join } from "node:path";

// The supported launch command runs from the repository root. Keeping this
// path fixed also prevents a browser-controlled asset name from becoming a
// filesystem lookup.
const UI_ROOT = join(process.cwd(), "tools/review-studio/ui");

const ASSET_FILES = new Map([
  ["review-studio.js", join(UI_ROOT, "review-studio.js")],
  ["review-studio.css", join(UI_ROOT, "review-studio.css")],
]);

/** Static local assets only; callers choose from the fixed map above. */
export function readReviewStudioAsset(name: "review-studio.js" | "review-studio.css"): string {
  const filePath = ASSET_FILES.get(name);
  if (!filePath) throw new Error("Unknown Review Studio asset");
  return readFileSync(filePath, "utf8");
}
