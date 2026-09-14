import type { ActionKind, Artifact, RunEvent, TestAction, TestResult, TestRun, TestStatus } from "../types";

export interface RecordActionInput {
  kind: ActionKind;
  tool: string;
  target?: string;
  value?: string;
  error?: string;
  durationMs: number;
  pageUrl?: string;
  pageTitle?: string;
  summary?: string;
  screenshot?: string;
}

/**
 * Owns the structured execution log for a single run.
 *
 * The action log is deliberately kept OUT of the LLM transcript: the report a
 * user sees must be derived from what actually happened in the browser, not
 * from what the model said happened.
 */
export class TestRunRecorder {
  readonly run: TestRun;
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private actionSeq = 0;

  constructor(run: TestRun) {
    this.run = run;
  }

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must never break a run */
      }
    }
  }

  setStatus(status: TestStatus): void {
    this.run.status = status;
    this.emit({ type: "status", status });
  }

  record(input: RecordActionInput): TestAction {
    this.actionSeq += 1;
    const action: TestAction = {
      id: `a${this.actionSeq}`,
      index: this.run.actions.length + 1,
      timestamp: Date.now(),
      kind: input.kind,
      tool: input.tool,
      target: input.target,
      value: input.value,
      result: input.error ? "failure" : "success",
      error: input.error,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      pageUrl: input.pageUrl,
      summary: input.summary,
      pageTitle: input.pageTitle,
      screenshot: input.screenshot,
    };
    this.run.actions.push(action);
    this.emit({ type: "action", action });
    return action;
  }

  addArtifact(artifact: Artifact): void {
    this.run.artifacts.push(artifact);
    this.emit({ type: "artifacts", artifacts: this.run.artifacts });
  }

  setResult(result: TestResult): void {
    this.run.result = result;
    this.emit({ type: "result", result });
  }

  fail(message: string): void {
    this.run.error = message;
    this.emit({ type: "error", message });
  }
}
