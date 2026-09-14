import { observe, type ToolDefinition } from "./context";

export const snapshotTool: ToolDefinition<Record<string, never>> = {
  name: "browser_snapshot",
  description:
    "Re-inspect the current page and return fresh element references (e1, e2, ...). " +
    "Use it whenever the page may have changed, when refs look stale, " +
    "or when you are unsure what is on screen.",
  actionKind: "snapshot",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args, ctx) => observe(ctx, `Snapshot of ${ctx.session.page.url()}`),
};
