import type { ToolDefinition } from "./context";

export interface FinishArgs {
  status: "passed" | "failed";
  summary: string;
  steps?: string[];
}

/**
 * Terminal tool. Having an explicit "I am done" signal makes the PASS/FAIL
 * verdict a structured value instead of something parsed out of prose.
 */
export const finishTool: ToolDefinition<FinishArgs> = {
  name: "finish_test",
  description:
    "Finish the run and report the verdict. Call this exactly once, as your last action, " +
    "after you have verified the outcome with browser_assert. " +
    "Report 'failed' if the expected outcome could not be observed.",
  actionKind: "finish",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["passed", "failed"], description: "The verdict." },
      summary: {
        type: "string",
        description: "One or two sentences describing what you did and what you observed.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Ordered list of the steps you performed, e.g. 'Opened the login page'.",
      },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },
  target: (args) => args.status,
  handler: async (args) => JSON.stringify({ status: args.status, summary: args.summary, steps: args.steps ?? [] }),
};
