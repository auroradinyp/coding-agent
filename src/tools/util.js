import path from "node:path";
import process from "node:process";

/** Resolves a user/agent supplied path against the working directory. */
export function resolveToolPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("path must be a non-empty string");
  }
  return path.resolve(process.cwd(), value);
}

/** Reads a text file, rejecting content that looks binary. */
export async function readText(fs, filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (raw.includes("\0")) throw new Error(`${filePath} looks like a binary file`);
  return raw;
}

/** Splits file content into lines (without the trailing empty element). */
export function splitLines(raw) {
  if (raw === "") return [];
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Reads a file and returns its lines. */
export async function readLines(fs, filePath) {
  return splitLines(await readText(fs, filePath));
}

export function displayPath(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}
