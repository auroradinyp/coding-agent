#!/usr/bin/env node
/**
 * `ca` — globally installed command for the coding agent.
 *
 * Thin wrapper around scripts/run.mjs: it defaults the entry point to the TUI
 * (src/index.js) and forwards the remaining flags.
 *
 *   ca                 start the TUI
 *   ca --network       start with the Chrome DevTools network tab
 *   ca --log-api       print every chat-completions request/response to stderr
 *   ca --help | --version
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { launch } from "../scripts/run.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_ENTRY = "src/index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`ca — minimal coding agent (Node >= 26.4, OpenTUI)

usage: ca [--network] [--log-api] [--help] [--version]

  --network   open a Chrome DevTools Network tab (NETWORK_DEBUG=1)
  --log-api   print chat-completions traffic to stderr (LOG_API=1)
  --version   print the version
  --help      show this message

config: ${path.join(ROOT, ".env")} (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL)
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

const entry = args.find((arg) => !arg.startsWith("-")) ?? DEFAULT_ENTRY;

process.exit(
  await launch(entry, {
    network: args.includes("--network"),
    logApi: args.includes("--log-api"),
  }),
);
