import fs from "node:fs/promises";
import { displayPath, readLines, resolveToolPath } from "./util.js";

export const editTool = {
  name: "edit",
  description:
    "Replace an inclusive range of 1-indexed lines [startLine, endLine] in a file with `content`. " +
    "Line numbers refer to the numbers printed by the read tool, so read the file first. " +
    "Use an empty `content` string to delete the range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)." },
      startLine: { type: "integer", description: "First line to replace (1-indexed, inclusive)." },
      endLine: { type: "integer", description: "Last line to replace (1-indexed, inclusive)." },
      content: { type: "string", description: "Replacement text. May contain multiple lines." },
    },
    required: ["path", "startLine", "endLine", "content"],
  },

  async run(args = {}) {
    const filePath = resolveToolPath(args.path);
    if (typeof args.content !== "string") throw new Error("content must be a string");

    const lines = await readLines(fs, filePath);
    const total = lines.length;

    const startLine = requireLine(args.startLine, "startLine");
    const endLine = requireLine(args.endLine, "endLine");

    if (startLine > endLine) throw new Error(`startLine (${startLine}) > endLine (${endLine})`);
    if (endLine > total) {
      throw new Error(
        `endLine (${endLine}) is past the end of ${displayPath(filePath)} (${total} lines). Read the file again.`,
      );
    }

    const replacement = args.content === "" ? [] : args.content.split("\n");
    const next = [
      ...lines.slice(0, startLine - 1),
      ...replacement,
      ...lines.slice(endLine),
    ];

    await fs.writeFile(filePath, next.length ? `${next.join("\n")}\n` : "", "utf8");

    return (
      `Edited ${displayPath(filePath)}: replaced lines ${startLine}-${endLine} ` +
      `with ${replacement.length} line(s). File now has ${next.length} lines.`
    );
  },
};

function requireLine(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}
