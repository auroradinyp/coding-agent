#!/usr/bin/env node
/**
 * Entry-point launcher.
 *
 * OpenTUI's native FFI needs Node >= 26.4 launched with `--experimental-ffi`.
 * Running an entry file with an older `node` dies on `bad option:
 * --experimental-ffi` (and, without the flag, on "native FFI is not available
 * for this runtime"), so this wrapper checks the running version first and,
 * when an nvm-installed Node satisfies the requirement, re-execs that one.
 *
 * Usage:
 *   node scripts/run.mjs [--network] [--log-api] <entry.js>
 *
 *   --network   set NETWORK_DEBUG=1 so the entry opens a Chrome DevTools
 *               Network tab (see src/devtools.js)
 *   --log-api   set LOG_API=1 so every chat-completions request/response is
 *               printed to stderr once the stream is merged (src/api-log.js)
 *
 * The same logic backs the globally installed `ca` command (bin/ca.mjs), which
 * imports `launch()` from here instead of passing an entry file.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIN_NODE = [26, 4, 0];

const parseVersion = (version) => version.replace(/^v/, "").split(".").map(Number);

function satisfies(version) {
  const [major, minor, patch] = parseVersion(version);
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE;
  if (major !== reqMajor) return major > reqMajor;
  if (minor !== reqMinor) return minor > reqMinor;
  return patch >= reqPatch;
}

/** Highest nvm-installed Node satisfying MIN_NODE, or undefined. */
function findNvmNode() {
  const root = process.env.NVM_DIR || path.join(homedir(), ".nvm");
  const dir = path.join(root, "versions", "node");
  if (!existsSync(dir)) return undefined;

  return readdirSync(dir)
    .filter((version) => satisfies(version))
    .sort((a, b) => {
      const [a1, a2, a3] = parseVersion(a);
      const [b1, b2, b3] = parseVersion(b);
      return b1 - a1 || b2 - a2 || b3 - a3;
    })
    .map((version) => path.join(dir, version, "bin", "node"))
    .find((binary) => existsSync(binary));
}

/**
 * Run `entry` (relative to the project root) under a Node that supports FFI.
 * Resolves with the child's exit code.
 */
export function launch(entry, { network = false, logApi = false } = {}) {
  let node = process.execPath;

  if (!satisfies(process.versions.node)) {
    const candidate = findNvmNode();
    if (!candidate) {
      console.error(
        `coding-agent needs Node >= ${MIN_NODE.join(".")} (running ${process.versions.node}).\n` +
          `Fix: nvm install && nvm use`,
      );
      return 1;
    }
    if (process.env.CA_QUIET !== "1") {
      console.log(`[run] Node ${process.versions.node} is too old, using ${candidate}`);
    }
    node = candidate;
  }

  const nodeArgs = ["--experimental-ffi"];
  const envFile = path.join(ROOT, ".env");
  if (existsSync(envFile)) nodeArgs.push(`--env-file=${envFile}`);
  nodeArgs.push(path.resolve(ROOT, entry));

  const env = { ...process.env };
  if (network) env.NETWORK_DEBUG = "1";
  if (logApi) env.LOG_API = "1";

  const child = spawn(node, nodeArgs, {
    stdio: "inherit",
    env,
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(0);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/** True when this file is the script Node was asked to run. */
export function isMain() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === import.meta.filename;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const network = args.includes("--network");
  const logApi = args.includes("--log-api");
  const entry = args.find((arg) => !arg.startsWith("-"));

  if (!entry) {
    console.error("usage: node scripts/run.mjs [--network] [--log-api] <entry.js>");
    process.exit(2);
  }

  process.exit(await launch(entry, { network, logApi }));
}
