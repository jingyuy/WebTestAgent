/**
 * Offline dry run — exercises the full browser tool layer with a hard-coded
 * script instead of an LLM.
 *
 * This is the regression test for the part of the agent that must never be
 * flaky: refs, snapshots, ref invalidation, clicking, filling and asserting.
 * If this passes, any agent failure is a *reasoning* failure, not a browser one.
 *
 *   npm run dry-run
 *   npm run dry-run -- --headed
 */
import * as path from "node:path";
import { BrowserSession } from "./browser/session";
import type { RefEntry } from "./browser/refs";
import { config } from "./config";
import { createRunDirs, summarizeRun, toArtifactPath, writeJson } from "./test-run/artifacts";
import { TestRunRecorder } from "./test-run/recorder";
import { toolsByName, type AnyTool, type ToolContext } from "./tools";
import type { ActionKind, TestAction, TestRun } from "./types";

interface Step {
  tool: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  label: string;
  /** Resolve the ref for `args.ref` by matching the latest snapshot. */
  target?: { testId?: string; name?: string; role?: string };
}

/** Find a ref in the current snapshot generation, the way the model would. */
function findRef(session: BrowserSession, matcher: { testId?: string; name?: string; role?: string }): string {
  const match = session.refs
    .all()
    .find(
      (entry: RefEntry) =>
        (!matcher.testId || entry.testId === matcher.testId) &&
        (!matcher.role || entry.role === matcher.role) &&
        (!matcher.name || entry.name === matcher.name),
    );
  if (!match) {
    const available = session.refs.all().map((entry) => `${entry.ref} ${entry.role} "${entry.name}"`).join("; ");
    throw new Error(`No element matched ${JSON.stringify(matcher)}. Available: ${available}`);
  }
  return match.ref;
}

async function main(): Promise<void> {
  const headed = process.argv.includes("--headed");
  const base = `http://localhost:${config.server.port}/demo/`;
  const runId = `dry-run-${Date.now()}`;
  const artifactsRoot = config.artifactsDir;
  const dirs = await createRunDirs(artifactsRoot, runId);

  const run: TestRun = {
    id: runId,
    url: base,
    instruction: "(scripted dry run — no LLM)",
    status: "running",
    startedAt: Date.now(),
    actions: [],
    artifacts: [],
  };
  const recorder = new TestRunRecorder(run);

  const session = await BrowserSession.create({
    headless: !headed,
    screenshotsDir: dirs.screenshotsDir,
    videosDir: dirs.videosDir,
  });

  const ctx: ToolContext = { session, recorder, artifactsRoot };

  const script: Step[] = [
    { tool: "browser_open", args: { url: base }, label: "Open demo app" },
    { tool: "browser_fill", args: { ref: "", value: "test@example.com" }, label: "Fill email", target: { testId: "email-input" } },
    { tool: "browser_fill", args: { ref: "", value: "password123" }, label: "Fill password", target: { testId: "password-input" } },
    { tool: "browser_click", args: { ref: "" }, label: "Sign in", target: { testId: "login-button" } },
    { tool: "browser_fill", args: { ref: "", value: "AI Test" }, label: "Name the project", target: { testId: "project-name-input" } },
    { tool: "browser_click", args: { ref: "" }, label: "Create project", target: { testId: "add-project-button" } },
    { tool: "browser_assert", args: { text: "AI Test", description: "project appears" }, label: "Verify project appears" },
    { tool: "browser_screenshot", args: { label: "verified" }, label: "Capture evidence" },
  ];

  let failures = 0;

  try {
    for (const [index, step] of script.entries()) {
      const tool: AnyTool | undefined = toolsByName.get(step.tool);
      if (!tool) throw new Error(`Unknown tool ${step.tool}`);

      // Refs always come from the newest snapshot, exactly like the model.
      if ("ref" in step.args) {
        if (tool.name !== "browser_open") await session.snapshot();
        step.args.ref = findRef(session, step.target ?? {});
      }

      const startedAt = Date.now();
      let error: string | undefined;
      let output = "";
      try {
        output = await tool.handler(step.args, ctx);
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
        output = `ERROR: ${error}`;
      }
      if (!error && tool.isFailure?.(output, step.args)) error = output.split("\n")[0];

      const action: TestAction = recorder.record({
        kind: tool.actionKind as ActionKind,
        tool: tool.name,
        target: tool.target?.(step.args),
        value: tool.value?.(step.args),
        error,
        durationMs: Date.now() - startedAt,
        pageUrl: session.page.url(),
        pageTitle: await session.title(),
        summary: output.split("\n")[0]?.slice(0, 200),
      });

      const mark = error ? "FAIL" : " ok ";
      process.stdout.write(
        `[${index + 1}/${script.length}] ${mark} ${step.label.padEnd(26)} ${action.target ?? ""} ${
          action.value ? `= ${JSON.stringify(action.value)}` : ""
        }${error ? ` -- ${error}` : ""}\n`,
      );
      if (error) failures += 1;
    }
  } finally {
    await session.close();
    run.status = failures === 0 ? "passed" : "failed";
    run.finishedAt = Date.now();
    run.durationMs = run.finishedAt - run.startedAt;
    run.result = {
      status: run.status,
      summary: failures === 0 ? "Scripted browser flow completed." : `${failures} scripted step(s) failed.`,
      steps: script.map((step) => step.label),
      assertions: run.actions
        .filter((action) => action.kind === "assert")
        .map((action) => ({ description: action.summary ?? "assertion", passed: action.result === "success" })),
    };
    for (const screenshot of run.actions.map((action) => action.screenshot).filter(Boolean) as string[]) {
      recorder.addArtifact({ kind: "screenshot", path: screenshot, createdAt: Date.now() });
    }
    const resultFile = path.join(dirs.runDir, "result.json");
    await writeJson(resultFile, run);
    recorder.addArtifact({
      kind: "result",
      path: toArtifactPath(artifactsRoot, resultFile),
      label: "result.json",
      createdAt: Date.now(),
    });
  }

  process.stdout.write(`\n${summarizeRun(run)}\n`);
  process.exit(run.status === "passed" ? 0 : 1);
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
