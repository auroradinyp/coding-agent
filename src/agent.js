import { streamChatCompletion } from "./llm.js";
import { createSession } from "./session.js";
import { toolSchemas, toolsByName } from "./tools/index.js";

export const SYSTEM_PROMPT = `You are a coding agent running in the user's terminal at ${process.cwd()}.

You have four tools:
- bash: run a shell command
- read: read a file (print line numbers)
- write: overwrite a whole file
- edit: replace a unique block of text (oldText) in a file with newText

Rules:
- Always read a file before editing it; copy oldText verbatim from what read printed.
- edit requires oldText to match exactly once; if it is ambiguous, include more surrounding lines.
- Prefer edit over write for existing files.
- Work step by step, then answer the user in plain text when you are done.
- Keep answers short.`;

/**
 * Creates an agent that owns one session (its conversation history).
 * All side effects are reported through `handlers`:
 * - onReasoningDelta / onTextDelta / onToolStart / onToolEnd as before
 * - onSessionChange(session) after every history mutation, so the caller can persist it
 */
export function createAgent({ handlers = {}, session = createSession() } = {}) {
  let current = attachSystemPrompt(session);

  const notify = () => handlers.onSessionChange?.(current);

  async function send(userText) {
    current.messages.push({ role: "user", content: userText });
    notify();

    for (;;) {
      const message = await streamChatCompletion({
        messages: current.messages,
        tools: toolSchemas,
        onTextDelta: handlers.onTextDelta,
        onReasoningDelta: handlers.onReasoningDelta,
      });

      current.messages.push(toHistoryMessage(message));
      notify();

      if (!message.tool_calls.length) {
        handlers.onTurnEnd?.(message);
        return message;
      }

      for (const toolCall of message.tool_calls) {
        handlers.onToolStart?.(toolCall);
        const result = await runToolCall(toolCall);
        handlers.onToolEnd?.(toolCall, result);
        current.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }
      notify();
    }
  }

  /** Switches to another session (used by /new and /resume). */
  function use(next) {
    current = attachSystemPrompt(next);
    return current;
  }

  return {
    send,
    use,
    get session() {
      return current;
    },
    get messages() {
      return current.messages;
    },
  };
}

/** The system prompt is derived (it embeds cwd) and never stored in a session file. */
function attachSystemPrompt(session) {
  if (session.messages[0]?.role !== "system") {
    session.messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }
  return session;
}

/** Strips reasoning_content (DeepSeek rejects it on the way back). */
function toHistoryMessage(message) {
  const out = { role: "assistant", content: message.content ?? "" };
  if (message.tool_calls.length) out.tool_calls = message.tool_calls;
  return out;
}

async function runToolCall(toolCall) {
  const name = toolCall.function?.name;
  const tool = toolsByName[name];
  if (!tool) return `Error: unknown tool "${name}"`;

  let args;
  const raw = toolCall.function?.arguments ?? "";
  try {
    args = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return `Error: arguments is not valid JSON (${err.message}). Received: ${raw.slice(0, 200)}`;
  }

  try {
    return await tool.run(args);
  } catch (err) {
    return `Error: ${err.message}`;
  }
}
