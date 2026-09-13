/**
 * Console logging of the chat-completions exchange.
 *
 * This is what `pnpm inspect` turns on (LOG_API=1): every call prints exactly
 * once, *after* the SSE stream has been merged into a final assistant message,
 * so you see the whole request payload and the whole reply instead of hundreds
 * of deltas.
 *
 * It works in both entry points:
 *   - src/cli.js (headless REPL) → the block goes to stderr.
 *   - src/index.js (TUI)         → opentui captures console output, and
 *     src/ui.js opens its console panel so the blocks are visible there.
 *
 * Long bodies are clipped at LOG_API_LIMIT chars (default 2000, 0 = no limit).
 */
import process from "node:process";
import util from "node:util";

const DEFAULT_LIMIT = 2000;
const WIDTH = 78;

export function apiLogEnabled() {
  return process.env.LOG_API === "1";
}

/** Prints one request/response pair. No-op unless LOG_API=1. */
export function logApiExchange({ url, payload, status, finishReason, message, error, durationMs }) {
  if (!apiLogEnabled()) return;
  const block = formatExchange({ url, payload, status, finishReason, message, error, durationMs });
  console.error(rawBlock(block));
}

/**
 * opentui renders console arguments through util.inspect, which quotes plain
 * strings and escapes their newlines. Handing it a custom-inspect object keeps
 * the block verbatim, so it looks identical in the TUI console panel and on a
 * normal terminal. (ANSI colours are avoided for the same reason: opentui
 * strips the escape byte and would leave the `[31m` codes as literal text.)
 */
function rawBlock(text) {
  return { [util.inspect.custom]: () => text };
}

// ── formatting ────────────────────────────────────────────────────────────

function formatExchange({ url, payload, status, finishReason, message, error, durationMs }) {
  const limit = bodyLimit();
  const at = new Date().toTimeString().slice(0, 8);
  const lines = [rule(` API · ${payload.model} · ${at} `)];

  lines.push(`│ POST ${url}`);
  lines.push(
    `│ stream=${payload.stream} · tool_choice=${payload.tool_choice} · ` +
      `tools=${(payload.tools ?? []).length} · messages=${payload.messages.length}`,
  );
  lines.push("│");
  for (const line of toJson(requestView(payload, limit)).split("\n")) lines.push(`│ ${line}`);

  lines.push("│");
  if (message) {
    const meta = `response ${status} · ${durationMs}ms${finishReason ? ` · ${finishReason}` : ""}`;
    lines.push(`│ ${meta}`);
    for (const line of toJson(responseView(message, limit)).split("\n")) lines.push(`│ ${line}`);
  } else {
    lines.push(`│ response failed after ${durationMs}ms: ${error?.message ?? error}`);
  }

  lines.push(rule());
  return lines.join("\n");
}

function rule(title = "") {
  if (!title) return `╰${"─".repeat(WIDTH - 1)}`;
  const tail = Math.max(0, WIDTH - title.length - 2);
  return `╭─${title}${"─".repeat(tail)}`;
}

function requestView(payload, limit) {
  return {
    model: payload.model,
    stream: payload.stream,
    tool_choice: payload.tool_choice,
    tools: payload.tools,
    messages: payload.messages.map((msg) => clipMessage(msg, limit)),
  };
}

function clipMessage(msg, limit) {
  const out = { ...msg };
  if (typeof out.content === "string") out.content = clip(out.content, limit);
  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((call) => ({
      ...call,
      function: { ...call.function, arguments: clip(call.function?.arguments ?? "", limit) },
    }));
  }
  return out;
}

function responseView(message, limit) {
  const out = { role: message.role, content: clip(message.content, limit) };
  if (message.reasoning_content) out.reasoning_content = clip(message.reasoning_content, limit);
  if (message.tool_calls?.length) {
    out.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: parseArguments(call.function?.arguments),
    }));
  }
  return out;
}

function parseArguments(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function clip(text, max) {
  if (typeof text !== "string" || !max || text.length <= max) return text;
  return `${text.slice(0, max)} … [${text.length - max} more chars · LOG_API_LIMIT=0 to see all]`;
}

function bodyLimit() {
  const raw = process.env.LOG_API_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LIMIT;
}

const toJson = (value) => JSON.stringify(value, null, 2);
