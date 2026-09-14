/**
 * Core domain types for the web test agent.
 *
 * These types are deliberately independent of the browser implementation and of
 * the LLM provider, so the action log / report survives any change of engine.
 */

export type TestStatus = "running" | "passed" | "failed" | "error";

/** Every mutation the agent applied to the page is recorded as one of these. */
export type ActionKind =
  | "open"
  | "snapshot"
  | "click"
  | "fill"
  | "press"
  | "select"
  | "wait"
  | "screenshot"
  | "assert"
  | "finish";

export interface TestAction {
  id: string;
  /** 1-based position in the run. */
  index: number;
  timestamp: number;
  kind: ActionKind;
  /** Name of the tool that produced this action, e.g. `browser_click`. */
  tool: string;
  /** Element ref (`e3`) or free-form target. */
  target?: string;
  /** Value written into the target, if any. */
  value?: string;
  result: "success" | "failure";
  error?: string;
  durationMs: number;
  pageUrl?: string;
  pageTitle?: string;
  /** First line of the tool output, for a compact human-readable log. */
  summary?: string;
  /** Artifact-relative path of the screenshot captured for this action. */
  screenshot?: string;
}

export type ArtifactKind = "screenshot" | "video" | "result" | "transcript";

export interface Artifact {
  kind: ArtifactKind;
  /** Path relative to the artifacts root, e.g. `run-x/screenshots/001-open.png`. */
  path: string;
  label?: string;
  createdAt: number;
}

export interface TestAssertion {
  description: string;
  passed: boolean;
  observed?: string;
}

export interface TestResult {
  status: "passed" | "failed";
  summary: string;
  steps: string[];
  assertions: TestAssertion[];
}

export interface TestRun {
  id: string;
  url: string;
  instruction: string;
  status: TestStatus;
  startedAt: number;
  finishedAt?: number;
  actions: TestAction[];
  artifacts: Artifact[];
  result?: TestResult;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Wall-clock duration in ms, filled in when the run completes. */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// LLM wire types (OpenAI-compatible function calling)
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Server -> UI stream messages. */
export type RunEvent =
  | { type: "status"; status: TestStatus }
  | { type: "action"; action: TestAction }
  | { type: "artifacts"; artifacts: Artifact[] }
  | { type: "assistant"; text: string }
  | { type: "result"; result: TestResult }
  | { type: "error"; message: string }
  | { type: "done"; run: TestRun };
