import { assertConfig, config } from "./config.js";
import { startTui } from "./ui.js";

assertConfig();

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});

console.log(`starting coding-agent (model: ${config.model}) ...`);
await startTui();
