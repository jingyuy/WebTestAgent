import type { ToolSchema } from "../types";
import { assertTool } from "./assert";
import { clickTool } from "./click";
import type { ToolDefinition } from "./context";
import { fillTool } from "./fill";
import { finishTool } from "./finish";
import { openTool } from "./open";
import { pressTool } from "./press";
import { screenshotTool } from "./screenshot";
import { selectTool } from "./select";
import { snapshotTool } from "./snapshot";
import { waitTool } from "./wait";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

/**
 * The complete browser toolset exposed to the model.
 *
 * Nine browser tools + one terminal tool. Deliberately no
 * `browser_execute_javascript`: the agent stays inside a small, auditable
 * vocabulary.
 */
export const browserTools: AnyTool[] = [
  openTool,
  snapshotTool,
  clickTool,
  fillTool,
  pressTool,
  selectTool,
  waitTool,
  screenshotTool,
  assertTool,
  finishTool,
];

export const toolsByName: Map<string, AnyTool> = new Map(browserTools.map((tool) => [tool.name, tool]));

/** Convert tool definitions into OpenAI-compatible function schemas. */
export function toToolSchemas(tools: AnyTool[] = browserTools): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export * from "./context";
