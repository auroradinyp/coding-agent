/**
 * Headless REPL — same agent loop as the TUI, no rendering.
 * Handy for debugging the loop: `pnpm run chat`
 */
import readline from "node:readline/promises";
import process from "node:process";
import { assertConfig, config } from "./config.js";
import { createAgent, SYSTEM_PROMPT } from "./agent.js";

assertConfig();

console.log(`coding-agent (headless) · model=${config.model} · cwd=${process.cwd()}`);
console.log(`system prompt:\n${SYSTEM_PROMPT}\n`);

const agent = createAgent({
  handlers: {
    onReasoningDelta: () => {},
    onTextDelta: (d) => process.stdout.write(d),
    onToolStart: (tc) => process.stdout.write(`\n\x1b[33m▶ ${tc.function.name} ${tc.function.arguments}\x1b[0m\n`),
    onToolEnd: (_tc, result) => process.stdout.write(`\x1b[90m${result}\x1b[0m\n`),
  },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  let line;
  try {
    line = await rl.question("\n\x1b[32m›\x1b[0m ");
  } catch {
    break;
  }
  const text = line.trim();
  if (!text) continue;
  if (text === "/exit") break;

  try {
    await agent.send(text);
  } catch (err) {
    console.error(`\n\x1b[31mError: ${err.message}\x1b[0m`);
  }
  console.log();
}

rl.close();
