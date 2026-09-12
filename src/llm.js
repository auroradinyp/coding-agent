import { config } from "./config.js";

/**
 * Minimal OpenAI-compatible chat completions client (streaming).
 * Returns an assistant message: { role, content, reasoning_content, tool_calls }
 * where each tool_call is { id, type: "function", function: { name, arguments } }.
 */
export async function streamChatCompletion({
  messages,
  tools,
  model = config.model,
  signal,
  onTextDelta,
  onReasoningDelta,
} = {}) {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${res.statusText}: ${body.slice(0, 800)}`);
  }
  if (!res.body) throw new Error("API returned an empty body");

  const message = {
    role: "assistant",
    content: "",
    reasoning_content: "",
    tool_calls: [],
  };

  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") break;

    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new Error(`API error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      message.content += delta.content;
      onTextDelta?.(delta.content);
    }
    if (delta.reasoning_content) {
      message.reasoning_content += delta.reasoning_content;
      onReasoningDelta?.(delta.reasoning_content);
    }

    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      message.tool_calls[index] ??= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      const slot = message.tool_calls[index];
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  }

  message.tool_calls = message.tool_calls.filter(Boolean);
  return message;
}

/** Yields the payload of every `data:` line of an SSE response body. */
async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
