import { observe, type ToolDefinition } from "./context";

export const fillTool: ToolDefinition<{ ref: string; value: string }> = {
  name: "browser_fill",
  description:
    "Type text into an input, textarea or contenteditable element identified by a ref. " +
    "Replaces any existing content. Returns a fresh snapshot.",
  actionKind: "fill",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: 'Element ref from the latest snapshot, e.g. "e1".' },
      value: { type: "string", description: "Text to type into the element." },
    },
    required: ["ref", "value"],
    additionalProperties: false,
  },
  target: (args) => args.ref,
  value: (args) => args.value,
  handler: async (args, ctx) => {
    const entry = ctx.session.refs.require(args.ref);
    await entry.locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
    await entry.locator.fill(String(args.value), { timeout: 15_000 });
    return observe(ctx, `Filled ${args.ref} (${entry.role} "${entry.name}") with ${JSON.stringify(args.value)}`);
  },
};
