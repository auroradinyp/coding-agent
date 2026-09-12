import fs from "node:fs/promises";
import path from "node:path";
import { displayPath, resolveToolPath } from "./util.js";

export const writeTool = {
  name: "write",
  description:
    "Write a file, replacing its whole content (creates missing parent directories). " +
    "Use edit to change only part of an existing file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)." },
      content: { type: "string", description: "Full content of the file." },
    },
    required: ["path", "content"],
  },

  async run(args = {}) {
    const filePath = resolveToolPath(args.path);
    if (typeof args.content !== "string") throw new Error("content must be a string");

    const content = args.content;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");

    const lineCount = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    return `Wrote ${displayPath(filePath)} (${lineCount} lines, ${Buffer.byteLength(content)} bytes)`;
  },
};
