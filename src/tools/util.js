import path from "node:path";
import process from "node:process";

/** Resolves a user/agent supplied path against the working directory. */
export function resolveToolPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("path must be a non-empty string");
  }
  return path.resolve(process.cwd(), value);
}

/** Reads a file and returns its lines (without the trailing empty element). */
export async function readLines(fs, filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  if (raw.includes("\0")) throw new Error(`${filePath} looks like a binary file`);
  if (raw === "") return [];
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function displayPath(filePath) {
  const rel = path.relative(process.cwd(), filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}
