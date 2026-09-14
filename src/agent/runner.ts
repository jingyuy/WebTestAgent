import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserSession } from "../browser/session";
import { config } from "../config";
import { createRunDirs, newRunId, toArtifactPath, writeJson, type RunDirs } from "../test-run/artifacts";
import { TestRunRecorder } from "../test-run/recorder";
import { browserTools, toolsByName, toToolSchemas, type AnyTool, type ToolContext } from "../tools";
import type { Artifact, RunEvent, TestResult, TestRun, ToolCall } from "../types";
import { createLlmClient, type ChatMessage, type ChatUsage, type LlmClient } from "./llm";
import { buildSystemPrompt, parseFinalAnswer } from "./prompt";

/** Tool calls after which a screenshot is captured automatically as evidence. */
const CAPTURE_AFTER = new Set(["browser_open", "browser_assert", "finish_test"]);

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_TRANSCRIPT_ENTRY_CHARS = 4_000;

export interface RunTestOptions {
  url: string;
  instruction: string;
  headless?: boolean;
  maxSteps?: number;
  recordVideo?: boolean;
  artifactsRoot?: string;
  /** Supply a pre-generated id (used by the server so the UI can subscribe). */
  runId?: string;
  llm?: LlmClient;
  onEvent?: (event: RunEvent) => void;
}

interface ExecuteResult {
  toolMessage: ChatMessage;
  finishResult?: TestResult;
}

export async function runTest(options: RunTestOptions): Promise<TestRun> {
  const url = options.url?.trim();
  const instruction = options.instruction?.trim();
  if (!url) throw new Error("A target URL is required.");
  if (!instruction) throw new Error("A test instruction is required.");

  const artifactsRoot = options.artifactsRoot ?? config.artifactsDir;
  const maxSteps = options.maxSteps ?? config.agent.maxSteps;
  const recordVideo = options.recordVideo ?? config.browser.recordVideo;
  const runId = options.runId ?? newRunId();

  const dirs = await createRunDirs(artifactsRoot, runId);

  const run: TestRun = {
    id: runId,
    url,
    instruction,
    status: "running",
    startedAt: Date.now(),
    actions: [],
    artifacts: [],
  };

  const recorder = new TestRunRecorder(run);
  if (options.onEvent) recorder.onEvent(options.onEvent);
  recorder.setStatus("running");

  const llm = options.llm ?? createLlmClient();
  const transcript: ChatMessage[] = [];

  let session: BrowserSession | undefined;
  let videoPath: string | undefined;

  try {
    session = await BrowserSession.create({
      headless: options.headless ?? config.browser.headless,
      screenshotsDir: dirs.screenshotsDir,
      videosDir: recordVideo ? dirs.videosDir : undefined,
      slowMo: config.browser.slowMo,
    });

    const ctx: ToolContext = { session, recorder, artifactsRoot };

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ url, instruction, maxSteps }) },
      {
        role: "user",
        content: `Execute this test.\n\nURL: ${url}\nINSTRUCTION: ${instruction}\n\nBegin with browser_open.`,
      },
    ];

    let finalResult: TestResult | undefined;
    let steps = 0;

    while (steps < maxSteps && !finalResult) {
      steps += 1;
      const response = await llm.chat(messages, toToolSchemas());
      accumulateUsage(run, response.usage);
      transcript.push(response.message);
      messages.push(response.message);

      if (response.message.content?.trim()) {
        recorder.emit({ type: "assistant", text: response.message.content.trim() });
      }

      const toolCalls = response.message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const parsed = parseFinalAnswer(response.message.content ?? "");
        if (parsed) {
          finalResult = parsed;
          break;
        }
        messages.push({
          role: "user",
          content:
            "Continue using the browser tools, or call finish_test with your verdict if you are done.",
        });
        continue;
      }

      for (const call of toolCalls) {
        const executed = await executeToolCall(call, ctx, session);
        transcript.push(executed.toolMessage);
        messages.push(executed.toolMessage);
        if (executed.finishResult) finalResult = executed.finishResult;
      }
    }

    // Evidence: always end with a final screenshot.
    await captureArtifact(ctx, "final", undefined);

    if (finalResult) {
      recorder.setResult(finalResult);
      recorder.setStatus(finalResult.status === "passed" ? "passed" : "failed");
    } else {
      recorder.fail(`The agent did not reach a verdict within ${maxSteps} steps.`);
      recorder.setStatus("error");
    }
  } catch (error) {
    recorder.fail(error instanceof Error ? error.message : String(error));
    recorder.setStatus("error");
  } finally {
    if (session) {
      // Closing the context flushes the video recording to disk.
      videoPath = await session.close().catch(() => undefined);
    }
    if (videoPath) {
      const renamed = await renameVideo(videoPath, dirs);
      if (renamed) {
        recorder.addArtifact({ kind: "video", path: renamed, label: "Recording", createdAt: Date.now() });
      }
    }
    await persistRun(run, dirs, recorder, transcript);
  }

  run.finishedAt = Date.now();
  run.durationMs = run.finishedAt - run.startedAt;
  recorder.emit({ type: "done", run });
  return run;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeToolCall(
  call: ToolCall,
  ctx: ToolContext,
  session: BrowserSession,
): Promise<ExecuteResult> {
  const tool: AnyTool | undefined = toolsByName.get(call.function.name);

  if (!tool) {
    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: `Unknown tool "${call.function.name}". Available tools: ${browserTools
          .map((t) => t.name)
          .join(", ")}.`,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let args: any = {};
  let parseError: string | undefined;
  if (call.function.arguments?.trim()) {
    try {
      args = JSON.parse(call.function.arguments);
    } catch (error) {
      parseError = (error as Error).message;
    }
  }

  const startedAt = Date.now();
  let output = "";
  let error: string | undefined;
  let finishResult: TestResult | undefined;
  let screenshotRel: string | undefined;

  if (parseError) {
    error = `could not parse arguments as JSON: ${parseError}`;
    output = `ERROR: ${error}. Expected schema: ${JSON.stringify(tool.parameters)}`;
  } else {
    try {
      output = await tool.handler(args, ctx);
    } catch (toolError) {
      error = toolError instanceof Error ? toolError.message : String(toolError);
      output = `ERROR: ${error}\n\nRecover by inspecting the current page with browser_snapshot before retrying.`;
    }
  }

  if (!error && tool.isFailure?.(output, args)) {
    error = firstLine(output);
  }

  if (!error && CAPTURE_AFTER.has(tool.name)) {
    screenshotRel = await captureArtifact(ctx, tool.name.replace(/^browser_/, ""), undefined);
  }

  recorderRecord(ctx, tool, args, {
    error,
    output,
    startedAt,
    screenshotRel,
    pageUrl: session.page.url(),
    pageTitle: await session.title(),
  });

  if (tool.name === "finish_test" && !error) {
    finishResult = {
      status: args.status === "passed" ? "passed" : "failed",
      summary: String(args.summary ?? "").trim() || "(no summary provided)",
      steps: Array.isArray(args.steps) ? args.steps.map((step: unknown) => String(step)) : [],
      assertions: ctx.recorder.run.actions
        .filter((action) => action.kind === "assert")
        .map((action) => ({ description: action.summary ?? "assertion", passed: action.result === "success" })),
    };
  }

  return {
    toolMessage: {
      role: "tool",
      tool_call_id: call.id,
      name: tool.name,
      content: clamp(output, MAX_TOOL_OUTPUT_CHARS),
    },
    finishResult,
  };
}

interface RecordInput {
  error?: string;
  output: string;
  startedAt: number;
  screenshotRel?: string;
  pageUrl: string;
  pageTitle: string;
}

function recorderRecord(ctx: ToolContext, tool: AnyTool, args: unknown, input: RecordInput): void {
  ctx.recorder.record({
    kind: tool.actionKind,
    tool: tool.name,
    target: tool.target?.(args),
    value: tool.value?.(args),
    error: input.error,
    durationMs: Date.now() - input.startedAt,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    summary: firstLine(input.error ? `ERROR: ${input.error}` : input.output),
    screenshot: input.screenshotRel,
  });
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

async function captureArtifact(
  ctx: ToolContext,
  label: string,
  fullPage: boolean | undefined,
): Promise<string | undefined> {
  try {
    const file = await ctx.session.screenshot(label, fullPage === true);
    const relative = toArtifactPath(ctx.artifactsRoot, file);
    ctx.recorder.addArtifact({ kind: "screenshot", path: relative, label, createdAt: Date.now() });
    return relative;
  } catch {
    return undefined;
  }
}

async function renameVideo(videoPath: string, dirs: RunDirs): Promise<string | undefined> {
  const target = path.join(dirs.videosDir, "video.webm");
  try {
    await fs.rename(videoPath, target);
    return toArtifactPath(dirs.artifactsRoot, target);
  } catch {
    return videoPath.startsWith(dirs.artifactsRoot) ? toArtifactPath(dirs.artifactsRoot, videoPath) : undefined;
  }
}

async function persistRun(
  run: TestRun,
  dirs: RunDirs,
  recorder: TestRunRecorder,
  transcript: ChatMessage[],
): Promise<void> {
  const resultFile = path.join(dirs.runDir, "result.json");
  await writeJson(resultFile, run);
  recorder.addArtifact({
    kind: "result",
    path: toArtifactPath(dirs.artifactsRoot, resultFile),
    label: "result.json",
    createdAt: Date.now(),
  });

  const transcriptFile = path.join(dirs.runDir, "transcript.json");
  const trimmed = transcript.map((message) => ({
    role: message.role,
    name: message.name,
    tool_call_id: message.tool_call_id,
    content:
      typeof message.content === "string" && message.content.length > MAX_TRANSCRIPT_ENTRY_CHARS
        ? `${message.content.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}…(truncated)`
        : message.content,
    tool_calls: message.tool_calls?.map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  }));
  await writeJson(transcriptFile, { runId: run.id, messages: trimmed });

  const artifact: Artifact = {
    kind: "transcript",
    path: toArtifactPath(dirs.artifactsRoot, transcriptFile),
    label: "transcript.json",
    createdAt: Date.now(),
  };
  recorder.addArtifact(artifact);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function accumulateUsage(run: TestRun, usage?: ChatUsage): void {
  if (!usage) return;
  const current = run.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  run.usage = {
    promptTokens: current.promptTokens + usage.promptTokens,
    completionTokens: current.completionTokens + usage.completionTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
  };
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated ${text.length - max} characters)`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.trim().slice(0, 240);
}
