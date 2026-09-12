import { streamChatCompletion } from "./llm.js";
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
 * Creates an agent that owns the conversation history.
 * All side effects are reported through `handlers`.
 */
export function createAgent({ handlers = {} } = {}) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  async function send(userText) {
    messages.push({ role: "user", content: userText });

    for (;;) {
      const message = await streamChatCompletion({
        messages,
        tools: toolSchemas,
        onTextDelta: handlers.onTextDelta,
        onReasoningDelta: handlers.onReasoningDelta,
      });

      messages.push(toHistoryMessage(message));

      if (!message.tool_calls.length) {
        handlers.onTurnEnd?.(message);
        return message;
      }

      for (const toolCall of message.tool_calls) {
        handlers.onToolStart?.(toolCall);
        const result = await runToolCall(toolCall);
        handlers.onToolEnd?.(toolCall, result);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }
    }
  }

  return { messages, send };
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
