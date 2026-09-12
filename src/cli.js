/**
 * Headless REPL — same agent loop as the TUI, no rendering.
 * Handy for debugging the loop: `pnpm run chat`
 */
import readline from "node:readline/promises";
import process from "node:process";
import { assertConfig, config } from "./config.js";
import { createAgent, SYSTEM_PROMPT } from "./agent.js";
import { HISTORY_DIR, createSessionStore, findSession } from "./session.js";

assertConfig();

const store = createSessionStore({
  dir: HISTORY_DIR,
  onError: (err) => console.error(`\x1b[31mcould not save session: ${err.message}\x1b[0m`),
});

process.on("exit", () => store.flush());

const agent = createAgent({
  session: store.create(),
  handlers: {
    onReasoningDelta: () => {},
    onTextDelta: (d) => process.stdout.write(d),
    onToolStart: (tc) => process.stdout.write(`\n\x1b[33m▶ ${tc.function.name} ${tc.function.arguments}\x1b[0m\n`),
    onToolEnd: (_tc, result) => process.stdout.write(`\x1b[90m${result}\x1b[0m\n`),
    onSessionChange: (session) => store.schedule(session),
  },
});

console.log(`coding-agent (headless) · model=${config.model} · cwd=${process.cwd()}`);
console.log(`sessions: ${store.dir} · current: ${agent.session.id}`);
console.log(`system prompt:\n${SYSTEM_PROMPT}\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const HELP = [
  "commands:",
  "  /new            start a fresh session",
  "  /resume [id]    list stored sessions and pick one (or resume <id> directly)",
  "  /help           this list",
  "  /exit           quit",
].join("\n");

const startSession = (session, banner) => {
  agent.use(session);
  console.log(`\x1b[36m── ${banner} ──\x1b[0m`);
};

const newSession = () => {
  store.flush();
  const session = store.create();
  startSession(session, `new session · ${session.id}`);
};

async function resume(id) {
  let target = id;
  if (!target) {
    const sessions = store.list();
    if (!sessions.length) {
      console.log(`\x1b[90mno saved sessions yet — they land in ${store.dir}\x1b[0m`);
      return;
    }
    console.log("saved sessions (newest first):");
    sessions.forEach((session, index) => {
      console.log(
        `  ${String(index + 1).padStart(2)}) ${session.title}  \x1b[90m· ${session.messageCount} messages · ${session.updatedAt || "?"} · ${session.id}\x1b[0m`,
      );
    });
    const answer = (await rl.question("resume # (empty to cancel) › ")).trim();
    if (!answer) return;
    const index = Number(answer);
    target = Number.isInteger(index) && index >= 1 && index <= sessions.length ? sessions[index - 1].id : answer;
  }

  const match = findSession(target, store.dir);
  if (!match) throw new Error(`no session matches "${target}"`);

  const session = store.load(match.id);
  store.flush();
  startSession(session, `resumed · ${session.id} · ${session.messages.length} messages`);
  if (session.cwd && session.cwd !== process.cwd()) {
    console.log(`\x1b[90mnote: that session ran in ${session.cwd} (now ${process.cwd()})\x1b[0m`);
  }
  for (const message of session.messages) {
    if (message.role === "user") console.log(`\x1b[32m› ${message.content}\x1b[0m`);
    if (message.role === "assistant" && message.content) console.log(message.content);
    for (const toolCall of message.tool_calls ?? []) {
      console.log(`\x1b[33m▶ ${toolCall.function.name} ${toolCall.function.arguments}\x1b[0m`);
    }
  }
}

while (true) {
  let line;
  try {
    line = await rl.question("\n\x1b[32m›\x1b[0m ");
  } catch {
    break;
  }
  const text = line.trim();
  if (!text) continue;

  if (text.startsWith("/")) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    try {
      switch (name.toLowerCase()) {
        case "new":
          newSession();
          break;
        case "resume":
          await resume(rest[0]);
          break;
        case "help":
          console.log(HELP);
          break;
        case "exit":
        case "quit":
          store.flush();
          rl.close();
          process.exit(0);
          break;
        default:
          console.log(`\x1b[31munknown command "${text}" — try /help\x1b[0m`);
      }
    } catch (err) {
      console.error(`\n\x1b[31mError: ${err.message}\x1b[0m`);
    }
    continue;
  }

  try {
    await agent.send(text);
  } catch (err) {
    console.error(`\n\x1b[31mError: ${err.message}\x1b[0m`);
  }
  console.log();
}

store.flush();
rl.close();
