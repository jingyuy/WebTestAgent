import { observe, type ToolDefinition } from "./context";

export interface WaitArgs {
  ms?: number;
  text?: string;
  ref?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  timeout?: number;
}

const MAX_SLEEP_MS = 10_000;

export const waitTool: ToolDefinition<WaitArgs> = {
  name: "browser_wait",
  description:
    "Wait for something to happen. Prefer waiting on a condition " +
    "(text appearing, or an element reaching a state) over a fixed delay: " +
    'e.g. {"text": "Saved"} or {"ref": "e9", "state": "visible"}. ' +
    'Use {"ms": 1000} only when there is no observable condition.',
  actionKind: "wait",
  parameters: {
    type: "object",
    properties: {
      ms: { type: "number", description: "Fixed delay in milliseconds (max 10000)." },
      text: { type: "string", description: "Wait until this text is visible on the page." },
      ref: { type: "string", description: "Wait for this element to reach the given state." },
      state: {
        type: "string",
        enum: ["attached", "detached", "visible", "hidden"],
        description: "State to wait for when a ref is supplied. Defaults to visible.",
      },
      timeout: { type: "number", description: "Max wait in milliseconds. Defaults to 10000." },
    },
    additionalProperties: false,
  },
  target: (args) => args.ref ?? args.text,
  value: (args) => (args.ms ? `${args.ms}ms` : args.state),
  handler: async (args, ctx) => {
    const timeout = Math.min(Math.max(args.timeout ?? 10_000, 100), 60_000);

    if (args.ref) {
      const entry = ctx.session.refs.require(args.ref);
      const state = args.state ?? "visible";
      await entry.locator.waitFor({ state, timeout });
      return observe(ctx, `Element ${args.ref} reached state "${state}"`);
    }

    if (args.text) {
      await ctx.session.page
        .getByText(args.text, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout });
      return observe(ctx, `Text ${JSON.stringify(args.text)} became visible`);
    }

    const ms = Math.min(Math.max(args.ms ?? 500, 0), MAX_SLEEP_MS);
    await ctx.session.page.waitForTimeout(ms).catch(() => undefined);
    return observe(ctx, `Waited ${ms}ms`);
  },
};
