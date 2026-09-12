/**
 * Session persistence: one JSON file per conversation (the "historys" dir).
 *
 * The leading system message is never written to disk — it embeds `process.cwd()`
 * and is rebuilt by the agent on load — everything else is stored verbatim so a
 * resumed session has the exact tool_calls / tool results the model produced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const DEFAULT_HISTORY_DIR = path.join(os.homedir(), ".coding-agent", "historys");
export const HISTORY_DIR =
  process.env.CODING_AGENT_HISTORY_DIR?.trim() || DEFAULT_HISTORY_DIR;

const FORMAT_VERSION = 1;
const TITLE_MAX = 60;
const SAVE_DEBOUNCE_MS = 250;

/** `2026-01-02T03:04:05.678Z` -> `2026-01-02T03-04-05-678Z`: filename safe, still sortable. */
export function toSessionId(date = new Date()) {
  return date.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

/** A brand new, empty session. `store.create()` is the usual entry point. */
export function createSession({ cwd = process.cwd(), now = new Date() } = {}) {
  return {
    id: toSessionId(now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cwd,
    title: "",
    messages: [],
  };
}

/** Title of a session: first non-empty line of the first user message. */
export function deriveTitle(messages, max = TITLE_MAX) {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const line = message.content
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean);
    if (!line) continue;
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
  }
  return "(empty session)";
}

export function sessionPath(dir, id) {
  return path.join(dir, `${path.basename(String(id))}.json`);
}

/** Writes `session` to `<dir>/<id>.json` (atomically). Returns false for empty sessions. */
export function saveSession(session, dir = HISTORY_DIR) {
  const messages = session.messages.filter((message) => message.role !== "system");
  if (!messages.length) return false;

  const record = {
    version: FORMAT_VERSION,
    id: session.id,
    title: session.title?.trim() || deriveTitle(messages),
    cwd: session.cwd || process.cwd(),
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    messages,
  };

  fs.mkdirSync(dir, { recursive: true });
  const file = sessionPath(dir, session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);

  session.title = record.title;
  session.updatedAt = record.updatedAt;
  return true;
}

/** Reads one session back; the system message is not present in the result. */
export function loadSession(id, dir = HISTORY_DIR) {
  const record = JSON.parse(fs.readFileSync(sessionPath(dir, id), "utf8"));
  const now = new Date().toISOString();
  return {
    id: record.id || String(id),
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || record.createdAt || now,
    cwd: record.cwd || process.cwd(),
    title: record.title || "",
    messages: Array.isArray(record.messages) ? record.messages : [],
  };
}

/** Metadata of every stored session, newest first. Broken files are skipped. */
export function listSessions(dir = HISTORY_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
      sessions.push({
        id: record.id || entry.name.slice(0, -".json".length),
        title: record.title?.trim() || "(untitled)",
        cwd: record.cwd || "",
        createdAt: record.createdAt || "",
        updatedAt: record.updatedAt || record.createdAt || "",
        messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
      });
    } catch {
      // Unreadable or unknown format: ignore it rather than breaking the picker.
    }
  }

  return sessions.sort((a, b) =>
    a.updatedAt === b.updatedAt ? b.id.localeCompare(a.id) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

/** Looks a session up by exact id, or by a prefix that matches exactly one id. */
export function findSession(idOrPrefix, dir = HISTORY_DIR) {
  const needle = String(idOrPrefix);
  const sessions = listSessions(dir);
  const exact = sessions.find((session) => session.id === needle);
  if (exact) return exact;
  const matches = sessions.filter((session) => session.id.startsWith(needle));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Session store bound to one directory. Writes are debounced (a single turn can
 * touch the history several times) but `flush()` is synchronous, so it is safe
 * to call from a `process.on("exit")` handler.
 */export function createSessionStore({ dir = HISTORY_DIR, onError, debounceMs = SAVE_DEBOUNCE_MS } = {}) {
  let timer = null;
  let pending = null;
  // Ids handed out but not on disk yet (two /new within the same millisecond).
  const issued = new Set();

  const write = (session) => {
    try {
      saveSession(session, dir);
    } catch (err) {
      onError?.(err, session);
    }
    return session;
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    dir,

    /** New empty session with an id that does not collide with an existing file. */
    create({ cwd = process.cwd(), now } = {}) {
      const session = createSession({ cwd, now });
      let candidate = session.id;
      for (let n = 2; issued.has(candidate) || fs.existsSync(sessionPath(dir, candidate)); n++) {
        candidate = `${session.id}-${n}`;
      }
      issued.add(candidate);
      session.id = candidate;
      return session;
    },

    list: () => listSessions(dir),
    load: (id) => loadSession(id, dir),

    /** Immediate write (used on /new, /resume and on exit). */
    save(session) {
      cancel();
      pending = null;
      return write(session);
    },

    /** Coalesced write, called after every history change. */
    schedule(session) {
      pending = session;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        const session = pending;
        pending = null;
        if (session) write(session);
      }, debounceMs);
    },

    flush() {
      cancel();
      if (!pending) return;
      const session = pending;
      pending = null;
      write(session);
    },
  };
}
