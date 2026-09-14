import * as path from "node:path";
import { addArtifact, type ToolDefinition } from "./context";

export interface ScreenshotArgs {
  label?: string;
  fullPage?: boolean;
}

export const screenshotTool: ToolDefinition<ScreenshotArgs> = {
  name: "browser_screenshot",
  description:
    "Capture the current page as evidence. Use it for important milestones " +
    "(after login, after saving, before/after a risky step). " +
    "It does not change the page, so refs stay valid.",
  actionKind: "screenshot",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: 'Short label, e.g. "after-login".' },
      fullPage: { type: "boolean", description: "Capture the whole scrollable page." },
    },
    additionalProperties: false,
  },
  target: (args) => args.label,
  handler: async (args, ctx) => {
    const label = args.label ?? "screenshot";
    const file = await ctx.session.screenshot(label, args.fullPage === true);
    const relative = addArtifact(ctx, file, "screenshot", label);
    return `Screenshot saved as ${relative} (${path.basename(file)}). The page was not modified; existing refs are still valid.`;
  },
};
