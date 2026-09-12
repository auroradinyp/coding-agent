import {
  BoxRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
} from "@opentui/core";
import process from "node:process";
import { createAgent } from "./agent.js";
import { config } from "./config.js";
import { HISTORY_DIR, createSessionStore, findSession } from "./session.js";

const COLORS = {
  text: "#c0caf5",
  dim: "#565f89",
  accent: "#7aa2f7",
  user: "#9ece6a",
  tool: "#e0af68",
  error: "#f7768e",
  border: "#3b4261",
};

/** Height (in text rows) of the multi-line input, not counting the box border. */
const INPUT_HEIGHT = 5;
/** Max characters of tool output kept in a block body. */
const TOOL_OUTPUT_LIMIT = 1500;
/** Max sessions visible at once in the /resume picker. */
const PICKER_VISIBLE = 8;

export async function startTui(options = {}) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
  });

  const app = createApp(renderer, options);
  app.input.focus();
  renderer.requestRender();
}

/** Builds the whole UI on a renderer. Split out so tests can drive it headlessly. */
export function createApp(renderer, { historyDir = HISTORY_DIR } = {}) {
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
    content: `coding-agent  ·  ${config.model}`,
    fg: COLORS.accent,
  });

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    // flexBasis 0 + minHeight 0 keeps the transcript from stealing rows from the input box: without
    // it yoga sizes the transcript from its (tall) content and then shrinks the siblings, which used
    // to squash the input box to 2 rows and clip its bottom border.
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
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
    // Explicit height (content + 2 border rows) and flexShrink 0 pin the box: the auto height alone
    // let yoga collapse it while the textarea inside kept its own height, so the placeholder ended up
    // drawn on the bottom border row instead of inside the box.
    height: INPUT_HEIGHT + 2,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: COLORS.border,
    focusedBorderColor: COLORS.accent,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: "#1a1b26",
  });

  const input = new TextareaRenderable(renderer, {
    id: "input",
    height: INPUT_HEIGHT,
    wrapMode: "word",
    placeholder: "Ask anything...  (enter to send · shift+enter for a new line)",
    placeholderColor: COLORS.dim,
    textColor: COLORS.text,
    focusedTextColor: COLORS.text,
    backgroundColor: "#1a1b26",
    focusedBackgroundColor: "#1a1b26",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", shift: true, action: "newline" },
    ],
    onSubmit: () => {
      const value = input.plainText.trim();
      input.setText("");
      if (!value || busy || picker) return;
      if (value.startsWith("/")) {
        runCommand(value);
        return;
      }
      void submit(value);
    },
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

  let blockId = 0;

  const addBlock = (text, fg) => {
    const block = new TextRenderable(renderer, {
      id: `block-${++blockId}`,
      content: text,
      fg,
      wrapMode: "word",
      marginBottom: 1,
    });
    transcript.add(block);
    scrollToBottom();
    return block;
  };

  const scrollToBottom = () => {
    transcript.scrollTop = transcript.scrollHeight;
    renderer.requestRender();
  };

  const setStatus = (text, fg = COLORS.dim) => {
    status.content = text;
    status.fg = fg;
    renderer.requestRender();
  };

  // Thinking and tool output are hidden by default: each gets a collapsed block that only shows a
  // clickable header. Clicking the header toggles the body, in both directions. The state lives on
  // the block itself, so headers stay clickable after the turn has ended.
  const hint = (expanded) => (expanded ? "click to collapse" : "click to expand");
  const arrow = (expanded) => (expanded ? "▼" : "▶");

  const toggleBlock = (block, expanded = !block.expanded) => {
    if (block.expanded === expanded) return;
    block.expanded = expanded;
    if (expanded) {
      block.body.content = block.text;
      block.box.add(block.body);
    } else {
      block.box.remove(block.body);
    }
    block.header.fg = expanded ? COLORS.dim : block.fg;
    block.renderHeader(block);
    scrollToBottom();
  };

  const createCollapsible = ({ idPrefix, fg, renderHeader, ...state }) => {
    const box = new BoxRenderable(renderer, {
      id: `${idPrefix}-${++blockId}`,
      flexDirection: "column",
      marginBottom: 1,
    });
    const header = new TextRenderable(renderer, {
      id: `${box.id}-header`,
      content: "",
      fg,
    });
    const body = new TextRenderable(renderer, {
      id: `${box.id}-body`,
      content: "",
      fg: COLORS.dim,
      wrapMode: "word",
    });
    const block = { box, header, body, fg, text: "", expanded: false, renderHeader, ...state };

    header.onMouseDown = () => toggleBlock(block);
    renderHeader(block);
    box.add(header);
    transcript.add(box);
    return block;
  };

  let reasoning = null;

  const addReasoningBlock = () =>
    createCollapsible({
      idPrefix: "reasoning",
      fg: COLORS.accent,
      renderHeader: (block) => {
        block.header.content = `${arrow(block.expanded)} thinking · ${block.text.length} chars (${hint(block.expanded)})`;
      },
    });

  const renderReasoning = () => {
    if (!reasoning) return;
    if (reasoning.expanded) reasoning.body.content = reasoning.text;
    else reasoning.renderHeader(reasoning);
    scrollToBottom();
  };

  const toolBlocks = new Map();

  const addToolBlock = (toolCall) =>
    createCollapsible({
      idPrefix: "tool",
      fg: COLORS.tool,
      title: formatToolCall(toolCall),
      summary: "",
      renderHeader: (block) => {
        const suffix = block.summary ? ` · ${block.summary} (${hint(block.expanded)})` : "";
        block.header.content = `${arrow(block.expanded)} ${block.title}${suffix}`;
      },
    });

  const finishToolBlock = (toolCall, result) => {
    const block = toolBlocks.get(toolCall.id);
    if (!block) return;
    block.text = indent(truncate(result, TOOL_OUTPUT_LIMIT));
    block.summary = summarize(result);
    if (block.expanded) block.body.content = block.text;
    block.renderHeader(block);
    scrollToBottom();
  };

  let busy = false;
  let stream = null;

  // ── sessions ────────────────────────────────────────────────────────────────
  // Every history change is written back to ~/.coding-agent/historys (debounced);
  // /new and /resume switch the session the agent appends to.
  const store = createSessionStore({
    dir: historyDir,
    onError: (err) => addBlock(`could not save session: ${err.message}`, COLORS.error),
  });

  const setTitle = () => {
    title.content = `coding-agent  ·  ${config.model}  ·  session ${agent.session.id}`;
    renderer.requestRender();
  };

  let picker = null;

  const handlers = {
    onReasoningDelta(delta) {
      reasoning ??= addReasoningBlock();
      reasoning.text += delta;
      renderReasoning();
    },
    onTextDelta(delta) {
      if (!stream || stream.kind !== "text") {
        stream = { kind: "text", acc: "", block: null };
      }
      stream.acc += delta;
      stream.block ??= addBlock("", COLORS.text);
      stream.block.content = stream.acc;
      scrollToBottom();
    },
    onToolStart(toolCall) {
      stream = null;
      toolBlocks.set(toolCall.id, addToolBlock(toolCall));
    },
    onToolEnd(toolCall, result) {
      finishToolBlock(toolCall, result);
    },
    onTurnEnd() {
      stream = null;
      reasoning = null;
      toolBlocks.clear();
    },
    onSessionChange(session) {
      store.schedule(session);
    },
  };

  const agent = createAgent({ handlers, session: store.create() });

  // ── session commands ────────────────────────────────────────────────────────

  const clearTranscript = () => {
    for (const child of [...transcript.getChildren()]) transcript.remove(child);
    scrollToBottom();
  };

  /** Replays a stored conversation into the transcript (reasoning is not persisted). */
  const renderHistory = (session) => {
    const blocks = new Map();
    for (const message of session.messages) {
      if (message.role === "user") {
        addBlock(`› ${message.content}`, COLORS.user);
      } else if (message.role === "assistant") {
        if (message.content) addBlock(message.content, COLORS.text);
        for (const toolCall of message.tool_calls ?? []) {
          blocks.set(toolCall.id, addToolBlock(toolCall));
        }
      } else if (message.role === "tool") {
        const block = blocks.get(message.tool_call_id);
        if (!block) continue;
        block.text = indent(truncate(message.content ?? "", TOOL_OUTPUT_LIMIT));
        block.summary = summarize(message.content ?? "");
        block.renderHeader(block);
      }
    }
    scrollToBottom();
  };

  const startSession = (session, banner) => {
    agent.use(session);
    clearTranscript();
    addBlock(banner, COLORS.accent);
    setTitle();
  };

  const newSession = () => {
    store.flush();
    const session = store.create();
    startSession(session, `── new session  ·  ${session.id} ──`);
    setStatus("ready");
  };

  const resumeSession = (id) => {
    store.flush();
    const session = store.load(id);
    startSession(
      session,
      `── resumed  ·  ${session.id}  ·  ${session.messages.length} messages restored ──`,
    );
    if (session.cwd && session.cwd !== process.cwd()) {
      addBlock(`note: that session ran in ${session.cwd} (now ${process.cwd()})`, COLORS.dim);
    }
    renderHistory(session);
    setStatus("ready");
  };

  const closePicker = () => {
    if (!picker) return;
    picker.select.blur();
    root.remove(picker.box);
    picker = null;
    input.focus();
    renderer.requestRender();
  };

  function openPicker() {
    const sessions = store.list();
    if (!sessions.length) {
      addBlock(`no saved sessions yet — they land in ${store.dir}`, COLORS.dim);
      return;
    }

    const visible = Math.min(sessions.length, PICKER_VISIBLE);
    const box = new BoxRenderable(renderer, {
      id: "resume-picker",
      position: "absolute",
      top: 2,
      left: "8%",
      width: "84%",
      height: visible * 2 + 2,
      zIndex: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.accent,
      title: " resume a session  (↑↓ move · enter resume · esc cancel) ",
      titleAlignment: "center",
      titleColor: COLORS.accent,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: "#1a1b26",
    });

    const select = new SelectRenderable(renderer, {
      id: "resume-select",
      width: "100%",
      height: visible * 2,
      options: sessions.map((session) => ({
        name: clip(session.title, 56),
        description: `${formatAge(session.updatedAt)} · ${session.messageCount} messages · ${session.id}`,
        value: session.id,
      })),
      showScrollIndicator: sessions.length > visible,
      wrapSelection: true,
      backgroundColor: "#1a1b26",
      focusedBackgroundColor: "#1a1b26",
      textColor: COLORS.text,
      focusedTextColor: COLORS.text,
      selectedBackgroundColor: COLORS.accent,
      selectedTextColor: "#1a1b26",
      descriptionColor: COLORS.dim,
      selectedDescriptionColor: "#1a1b26",
    });

    select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      closePicker();
      try {
        resumeSession(option.value);
      } catch (err) {
        addBlock(`could not resume ${option.value}: ${err.message}`, COLORS.error);
        setStatus("error", COLORS.error);
      }
    });

    box.add(select);
    root.add(box);
    picker = { box, select };
    input.blur();
    select.focus();
    renderer.requestRender();
  }

  /** `/resume` with no argument opens the picker; `/resume <id>` jumps straight in. */
  function resume(idOrPrefix) {
    if (!idOrPrefix) return openPicker();

    const match = findSession(idOrPrefix, store.dir);
    if (!match) {
      addBlock(`no session matches "${idOrPrefix}"`, COLORS.error);
      return;
    }

    try {
      resumeSession(match.id);
    } catch (err) {
      addBlock(`could not resume ${match.id}: ${err.message}`, COLORS.error);
      setStatus("error", COLORS.error);
    }
  }

  const HELP = [
    "commands:",
    "  /new            start a fresh session (the current one stays on disk)",
    "  /resume [id]    pick a stored session (↑↓ + enter) and keep chatting",
    "  /help           this list",
    "  /exit           quit   ·   ctrl+c also quits",
    `sessions live in ${store.dir}`,
  ].join("\n");

  const runCommand = (line) => {
    const [name = "", ...rest] = line.trim().slice(1).split(/\s+/);
    switch (name.toLowerCase()) {
      case "new":
        newSession();
        break;
      case "resume":
        resume(rest[0]);
        break;
      case "help":
        addBlock(HELP, COLORS.dim);
        break;
      case "exit":
      case "quit":
        shutdown();
        break;
      default:
        addBlock(`unknown command "${line}" — try /help`, COLORS.error);
    }
  };

  function shutdown() {
    store.flush();
    renderer.destroy();
  }

  // Esc closes the picker; the key must not reach the select underneath.
  renderer.keyInput.on("keypress", (key) => {
    if (key.name !== "escape" || !picker) return;
    key.preventDefault();
    key.stopPropagation();
    closePicker();
  });

  // Fallback for ctrl+c and anything else that ends the process.
  process.on("exit", () => store.flush());

  async function submit(value) {
    busy = true;
    setStatus("thinking...", COLORS.accent);
    addBlock(`› ${value}`, COLORS.user);

    try {
      await agent.send(value);
      setStatus("ready");
    } catch (err) {
      stream = null;
      reasoning = null;
      toolBlocks.clear();
      addBlock(`Error: ${err.message}`, COLORS.error);
      setStatus("error", COLORS.error);
    } finally {
      busy = false;
      renderer.requestRender();
    }
  }

  addBlock(
    `Type a request and press enter. The agent can run bash and read/write/edit files in ${process.cwd()}`,
    COLORS.dim,
  );
  addBlock(`/help for commands  ·  /new to start over  ·  /resume to pick an old session`, COLORS.dim);
  setTitle();

  return {
    root,
    transcript,
    input,
    inputBox,
    handlers,
    agent,
    store,
    addBlock,
    setStatus,
    newSession,
    resumeSession,
    openPicker,
  };
}

/** Compact relative time for the resume picker ("4m ago", "3d ago", "2026-01-02"). */
function formatAge(iso) {
  const then = Date.parse(iso ?? "");
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function formatToolCall(toolCall) {
  const args = toolCall.function?.arguments ?? "";
  const firstLine = args.split("\n")[0];
  return `${toolCall.function?.name} ${truncate(firstLine, 200)}`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated]`;
}

/** One-line summary of a tool result, shown in the collapsed header. */
function summarize(result) {
  const text = result.trim();
  if (!text) return "no output";
  const lines = text.split("\n").length;
  return lines === 1 ? clip(text, 60) : `${lines} lines`;
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function indent(text) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
