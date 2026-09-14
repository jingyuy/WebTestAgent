import { observe, type ToolDefinition } from "./context";

export const clickTool: ToolDefinition<{ ref: string }> = {
  name: "browser_click",
  description:
    "Click an element by its ref from the most recent snapshot. " +
    "Returns a fresh snapshot of the resulting page state.",
  actionKind: "click",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: 'Element ref from the latest snapshot, e.g. "e4".' },
    },
    required: ["ref"],
    additionalProperties: false,
  },
  target: (args) => args.ref,
  handler: async (args, ctx) => {
    const entry = ctx.session.refs.require(args.ref);
    await entry.locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await entry.locator.click({ timeout: 15_000 });
    return observe(ctx, `Clicked ${args.ref} (${entry.role} "${entry.name}")`);
  },
};
