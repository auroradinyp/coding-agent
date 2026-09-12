import fs from "node:fs/promises";
import { displayPath, readText, resolveToolPath, splitLines } from "./util.js";

export const editTool = {
  name: "edit",
  description:
    "Replace a unique block of text in a file: `newText` takes the place of `oldText`. " +
    "`oldText` must match the file exactly (indentation and blank lines included) and must occur " +
    "only once; extend it with surrounding lines until it is unique. " +
    "An empty `newText` deletes the block. Read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, or relative to the working directory)." },
      oldText: {
        type: "string",
        description:
          "Exact text to replace, copied from the file. Indentation and blank lines must match. " +
          "Must occur exactly once in the file.",
      },
      newText: {
        type: "string",
        description: "Replacement text. May contain multiple lines. An empty string deletes `oldText`.",
      },
    },
    required: ["path", "oldText", "newText"],
  },

  async run(args = {}) {
    const filePath = resolveToolPath(args.path);
    if (typeof args.oldText !== "string" || args.oldText === "") {
      throw new Error("oldText must be a non-empty string");
    }
    if (typeof args.newText !== "string") throw new Error("newText must be a string");

    const raw = await readText(fs, filePath);

    // Match against LF-normalized text so files with CRLF endings still work when the model copies
    // text from the read tool; the file's own line ending is restored on write.
    const crlf = raw.includes("\r\n");
    const body = toLf(raw);
    const oldBlock = toLf(args.oldText);
    const newBlock = toLf(args.newText);

    const at = body.indexOf(oldBlock);
    if (at === -1) {
      throw new Error(
        `oldText not found in ${displayPath(filePath)} (${plural(splitLines(body).length, "line")}). ` +
          "Read the file again and copy the text exactly, indentation and blank lines included.",
      );
    }

    const occurrences = countOccurrences(body, oldBlock);
    if (occurrences > 1) {
      throw new Error(
        `oldText occurs ${occurrences} times in ${displayPath(filePath)}. ` +
          "Extend it with more surrounding lines so that it matches exactly once.",
      );
    }

    const updated = body.slice(0, at) + newBlock + body.slice(at + oldBlock.length);
    await fs.writeFile(filePath, crlf ? updated.replaceAll("\n", "\r\n") : updated, "utf8");

    return (
      `Edited ${displayPath(filePath)}: replaced ${splitLines(oldBlock).length} line(s) with ` +
      `${splitLines(newBlock).length} line(s). File now has ${splitLines(updated).length} lines.`
    );
  },
};

function toLf(text) {
  return text.replaceAll("\r\n", "\n");
}

function plural(count, word) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count++;
  }
  return count;
}
