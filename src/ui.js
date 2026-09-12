import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { createAgent } from "./agent.js";

const COLORS = {
  text: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  user: "#9ece6a",
  tool: "#e0af68",
  error: "#f7768e",
  border: "#3b4261",
};

export async function startTui() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
  });

  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: "#1a1b26",
  });

  const title = new TextRenderable(renderer, {
    id: "title",
    content: "coding-agent  ·  deepseek-flash",
    fg: COLORS.accent,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    paddingLeft: 1,
    paddingRight: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
    scrollX: false,
    backgroundColor: "#1a1b26",
  });

  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    focusedBorderColor: COLORS.accent,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: "#1a1b26",
  });

  const input = new InputRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    placeholder: "Ask anything...  (ctrl+c to quit)",
    placeholderColor: COLORS.dim,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    backgroundColor: "#1a1b26",
    focusedBackgroundColor: "#1a1b26",
  });

  const status = new TextRenderable(renderer, {
    id: "status",
    content: "ready",
    fg: COLORS.dim,
  });

  inputBox.add(input);
  root.add(title);
  root.add(transcript);
  root.add(inputBox);
  root.add(status);
  renderer.root.add(root);

  const addBlock = (text, fg) => {
    const block = new TextRenderable(renderer, {
      content: text,
      fg,
      wrapMode: "word",
      marginBottom: 1,
    });
    transcript.add(block);
    transcript.scrollTop = transcript.scrollHeight;
    renderer.requestRender();
    return block;
  };

  const setStatus = (text, fg = COLORS.dim) => {
    status.content = text;
    status.fg = fg;
    renderer.requestRender();
  };

  let busy = false;
  let stream = null;

  const handlers = {
    onReasoningDelta(delta) {
      stream ??= { kind: "reasoning", acc: "", block: null };
      if (stream.kind !== "reasoning") stream = { kind: "reasoning", acc: "", block: null };
      stream.acc += delta;
      stream.block ??= addBlock("", COLORS.dim);
      stream.block.content = stream.acc;
      renderer.requestRender();
    },
    onTextDelta(delta) {
      if (!stream || stream.kind !== "text") {
        stream = { kind: "text", acc: "", block: null };
      }
      stream.acc += delta;
      stream.block ??= addBlock("", COLORS.text);
      stream.block.content = stream.acc;
      renderer.requestRender();
    },
    onToolStart(toolCall) {
      stream = null;
      addBlock(`▶ ${formatToolCall(toolCall)}`, COLORS.tool);
    },
    onToolEnd(_toolCall, result) {
      addBlock(indent(truncate(result, 1500)), COLORS.dim);
    },
    onTurnEnd() {
      stream = null;
    },
  };

  const agent = createAgent({ handlers });

  input.on("enter", () => {
    const value = input.value.trim();
    input.value = "";
    if (!value || busy) return;
    void submit(value);
  });

  async function submit(value) {
    busy = true;
    setStatus("thinking...", COLORS.accent);
    addBlock(`› ${value}`, COLORS.user);

    try {
      await agent.send(value);
      setStatus("ready");
    } catch (err) {
      stream = null;
      addBlock(`Error: ${err.message}`, COLORS.error);
      setStatus("error", COLORS.error);
    } finally {
      busy = false;
      renderer.requestRender();
    }
  }

  input.focus();
  renderer.requestRender();

  addBlock(
    "Type a request and press enter. The agent can run bash and read/write/edit files in " +
      process.cwd(),
    COLORS.dim,
  );
}

function formatToolCall(toolCall) {
  const args = toolCall.function?.arguments ?? "";
  const firstLine = args.split("\n")[0];
  return `${toolCall.function?.name} ${truncate(firstLine, 200)}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated]`;
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
