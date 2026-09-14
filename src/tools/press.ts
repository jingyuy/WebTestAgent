import { observe, type ToolDefinition } from "./context";

export const pressTool: ToolDefinition<{ key: string; ref?: string }> = {
  name: "browser_press",
  description:
    "Press a keyboard key. Supply a ref to press it on a specific element " +
    "(e.g. Enter inside a search box), or omit the ref to press it on the page.",
  actionKind: "press",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: 'Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+A".',
      },
      ref: { type: "string", description: "Optional element ref to focus first." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  target: (args) => args.ref,
  value: (args) => args.key,
  handler: async (args, ctx) => {
    if (args.ref) {
      const entry = ctx.session.refs.require(args.ref);
      await entry.locator.press(args.key, { timeout: 15_000 });
      return observe(ctx, `Pressed ${args.key} on ${args.ref} (${entry.role} "${entry.name}")`);
    }
    await ctx.session.page.keyboard.press(args.key);
    return observe(ctx, `Pressed ${args.key}`);
  },
};
