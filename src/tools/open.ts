import { observe, type ToolDefinition } from "./context";

export const openTool: ToolDefinition<{ url: string }> = {
  name: "browser_open",
  description:
    "Open a URL in the browser and return a snapshot of the loaded page. " +
    "Call this first. Always use this instead of assuming a page is already open.",
  actionKind: "open",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute URL, e.g. https://example.com/login" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  target: (args) => args.url,
  handler: async (args, ctx) => {
    await ctx.session.goto(args.url);
    return observe(ctx, `Opened ${ctx.session.page.url()}`);
  },
};
