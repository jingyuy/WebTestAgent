import type { ToolDefinition } from "./context";

export interface AssertArgs {
  ref?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  text?: string;
  url_contains?: string;
  title_contains?: string;
  timeout?: number;
}

interface ConditionResult {
  ok: boolean;
  message: string;
}

/** Poll a predicate until it is true or the timeout expires. */
async function poll(
  check: () => Promise<{ ok: boolean; observed: string }>,
  timeout: number,
): Promise<{ ok: boolean; observed: string }> {
  const deadline = Date.now() + timeout;
  let last = { ok: false, observed: "not evaluated" };
  for (;;) {
    last = await check().catch((error: Error) => ({ ok: false, observed: error.message }));
    if (last.ok || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Assertions are the difference between "I clicked Save" and "the save worked".
 *
 * A failed assertion is a *successful observation*, so this tool deliberately
 * does not throw: it returns an explicit ASSERTION PASSED / FAILED line that the
 * model (and the run report) must reckon with.
 */
export const assertTool: ToolDefinition<AssertArgs> = {
  name: "browser_assert",
  description:
    "Verify an expected outcome before reporting a result. Provide one or more of: " +
    "url_contains, title_contains, text (visible anywhere on the page), " +
    'ref + state (e.g. {"ref":"e9","state":"visible"}), or ref + text (element contains text). ' +
    "Returns ASSERTION PASSED or ASSERTION FAILED with the observed value.",
  actionKind: "assert",
  parameters: {
    type: "object",
    properties: {
      url_contains: { type: "string", description: "Expected substring of the current URL." },
      title_contains: { type: "string", description: "Expected substring of the page title." },
      text: { type: "string", description: "Text expected to be visible on the page." },
      ref: { type: "string", description: "Element ref to check." },
      state: {
        type: "string",
        enum: ["attached", "detached", "visible", "hidden"],
        description: "Expected state of the referenced element.",
      },
      timeout: { type: "number", description: "Max wait in milliseconds. Defaults to 5000." },
    },
    additionalProperties: false,
  },
  target: (args) =>
    args.ref ?? args.text ?? args.url_contains ?? args.title_contains,
  isFailure: (output) => output.startsWith("ASSERTION FAILED"),
  handler: async (args, ctx) => {
    const timeout = Math.min(Math.max(args.timeout ?? 5_000, 100), 30_000);
    const results: ConditionResult[] = [];

    if (args.url_contains) {
      const expected = args.url_contains;
      const outcome = await poll(
        async () => {
          const url = ctx.session.page.url();
          return { ok: url.includes(expected), observed: url };
        },
        timeout,
      );
      results.push({
        ok: outcome.ok,
        message: `URL contains ${JSON.stringify(expected)} (actual: ${outcome.observed})`,
      });
    }

    if (args.title_contains) {
      const expected = args.title_contains;
      const outcome = await poll(
        async () => {
          const title = await ctx.session.title();
          return { ok: title.includes(expected), observed: title };
        },
        timeout,
      );
      results.push({
        ok: outcome.ok,
        message: `Title contains ${JSON.stringify(expected)} (actual: ${JSON.stringify(outcome.observed)})`,
      });
    }

    if (args.ref && args.state) {
      const entry = ctx.session.refs.require(args.ref);
      let ok = true;
      let observed: string = args.state;
      try {
        await entry.locator.waitFor({ state: args.state, timeout });
      } catch (error) {
        ok = false;
        observed = (error as Error).message.split("\n")[0];
      }
      results.push({
        ok,
        message: `Element ${args.ref} (${entry.role} "${entry.name}") is ${args.state}`,
      });
      if (!ok) results[results.length - 1].message += ` — ${observed}`;
    }

    if (args.ref && args.text) {
      const entry = ctx.session.refs.require(args.ref);
      const expected = args.text;
      const outcome = await poll(
        async () => {
          const content = (await entry.locator.innerText().catch(() => "")) || "";
          return { ok: content.includes(expected), observed: content.replace(/\s+/g, " ").trim() };
        },
        timeout,
      );
      results.push({
        ok: outcome.ok,
        message: `Element ${args.ref} text contains ${JSON.stringify(expected)} (actual: ${JSON.stringify(
          outcome.observed.slice(0, 160),
        )})`,
      });
    }

    if (args.text && !args.ref) {
      const expected = args.text;
      const outcome = await poll(
        async () => {
          const visible = await ctx.session.page
            .getByText(expected, { exact: false })
            .first()
            .isVisible()
            .catch(() => false);
          return { ok: visible, observed: visible ? expected : "(not visible)" };
        },
        timeout,
      );
      results.push({
        ok: outcome.ok,
        message: `Page shows text ${JSON.stringify(expected)}`,
      });
    }

    if (results.length === 0) {
      throw new Error(
        "browser_assert needs at least one condition: url_contains, title_contains, text, or ref+state.",
      );
    }

    const header = results.every((r) => r.ok) ? "ASSERTION PASSED" : "ASSERTION FAILED";
    const body = results.map((r) => `${r.ok ? "PASS" : "FAIL"} - ${r.message}`).join("\n");
    return `${header}\n${body}`;
  },
};
