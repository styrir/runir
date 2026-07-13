export { bootstrap, createApp, resolveUserId } from "./src/app/server.js";

import { bootstrap, registerShutdownHandlers } from "./src/app/server.js";

function isMainModule() {
  const entry = process.argv[1];
  return !!entry && /(?:^|[\\/])index\.(?:ts|js)$/.test(entry);
}

if (isMainModule()) {
  bootstrap().catch((err) => {
    console.error("runir-service: startup failed:", err);
    process.exit(1);
  });

  registerShutdownHandlers();
}
