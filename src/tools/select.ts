import { observe, type ToolDefinition } from "./context";

export const selectTool: ToolDefinition<{ ref: string; value: string }> = {
  name: "browser_select",
  description:
    "Choose an option in a <select> dropdown by its value or visible label. " +
    "For custom dropdowns, use browser_click instead.",
  actionKind: "select",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Ref of the select element." },
      value: {
        type: "string",
        description: 'Option value or label, e.g. "daily".',
      },
    },
    required: ["ref", "value"],
    additionalProperties: false,
  },
  target: (args) => args.ref,
  value: (args) => args.value,
  handler: async (args, ctx) => {
    const entry = ctx.session.refs.require(args.ref);
    const selected = await entry.locator.selectOption(String(args.value), { timeout: 15_000 });
    return observe(
      ctx,
      `Selected ${JSON.stringify(selected)} in ${args.ref} (${entry.role} "${entry.name}")`,
    );
  },
};
