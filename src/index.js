import { assertConfig, config } from "./config.js";
import { registerNetworkDevtools } from "./devtools.js";
import { startTui } from "./ui.js";

assertConfig();

// Must run before the first request so fetch/http are patched in time.
await registerNetworkDevtools();

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});

console.log(`starting coding-agent (model: ${config.model}) ...`);
await startTui();
