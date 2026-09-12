import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

export const tools = [bashTool, readTool, writeTool, editTool];

/** OpenAI-style `tools` array for the chat completions request. */
export const toolSchemas = tools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export const toolsByName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
