import { db, provider } from "../src/app/runtime.js";
import { runDeploymentPreflight } from "../src/app/readiness.js";

async function main() {
  const report = await runDeploymentPreflight({
    db,
    provider,
    strict: true,
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await db.close().catch(() => undefined);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`runir deploy preflight failed: ${message}`);
  await db.close().catch(() => undefined);
  process.exit(1);
});
