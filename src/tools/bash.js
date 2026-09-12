import { spawn } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

export const bashTool = {
  name: "bash",
  description:
    "Run a bash command in the current working directory and return its stdout, stderr and exit code. " +
    "Prefer read/write/edit for file access.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute." },
      timeout: {
        type: "integer",
        description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}.`,
      },
    },
    required: ["command"],
  },

  async run(args = {}) {
    const { command } = args;
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("command must be a non-empty string");
    }

    const rawTimeout = Number(args.timeout);
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(rawTimeout, MAX_TIMEOUT)
      : DEFAULT_TIMEOUT;

    return await new Promise((resolve) => {
      // detached: true => the child becomes its own process group leader,
      // so we can kill the whole tree on timeout.
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeout);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`Error: failed to start command: ${err.message}`);
      });

      child.on("close", (code) => {
        clearTimeout(timer);

        const parts = [];
        if (stdout.trim()) parts.push(truncate(stdout.trimEnd()));
        if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trimEnd())}`);
        if (!parts.length) parts.push("(no output)");

        parts.push(`[exit code: ${code ?? "null"}]`);
        if (timedOut) parts.push(`[timed out after ${timeout}ms]`);

        resolve(parts.join("\n"));
      });
    });
  },
};

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, MAX_OUTPUT / 2);
  const tail = text.slice(-MAX_OUTPUT / 2);
  return `${head}\n\n... [${text.length - MAX_OUTPUT} characters truncated] ...\n\n${tail}`;
}
