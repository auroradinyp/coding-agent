import fs from "node:fs/promises";
import { displayPath, readLines, resolveToolPath } from "./util.js";

const MAX_LINES = 2000;

export const readTool = {
  name: "read",
  description:
    "Read a text file. Lines are 1-indexed and prefixed with their line number in the output. " +
    `At most ${MAX_LINES} lines are returned per call.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)." },
      startLine: { type: "integer", description: "First line to read (1-indexed, inclusive). Default 1." },
      endLine: { type: "integer", description: "Last line to read (1-indexed, inclusive). Default last line." },
    },
    required: ["path"],
  },

  async run(args = {}) {
    const filePath = resolveToolPath(args.path);
    const lines = await readLines(fs, filePath);
    const total = lines.length;
    if (total === 0) return `${displayPath(filePath)} (empty file)`;

    const start = clampLine(args.startLine, 1, total);
    const end = clampLine(args.endLine, total, total);
    if (start > end) throw new Error(`startLine (${start}) > endLine (${end})`);

    const slice = lines.slice(start - 1, Math.min(end, start - 1 + MAX_LINES));
    const lastShown = start + slice.length - 1;

    let body = slice
      .map((line, i) => `${String(start + i).padStart(6)}| ${line}`)
      .join("\n");

    if (end > lastShown) {
      body += `\n... [truncated: showing ${start}-${lastShown} of ${start}-${end}] ...`;
    }

    return `${displayPath(filePath)} (${total} lines, showing ${start}-${lastShown})\n${body}`;
  },
};

function clampLine(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), Math.max(max, 1));
}
