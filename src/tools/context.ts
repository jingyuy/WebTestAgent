import type { BrowserSession } from "../browser/session";
import type { TestRunRecorder } from "../test-run/recorder";
import { toArtifactPath } from "../test-run/artifacts";
import type { ActionKind, ArtifactKind } from "../types";

export interface ToolContext {
  session: BrowserSession;
  recorder: TestRunRecorder;
  /** Root artifacts directory, used to turn absolute paths into URL-safe ones. */
  artifactsRoot: string;
}

/**
 * A semantic browser tool exposed to the model.
 *
 * Note the shape: the model gets *intent* level operations (`click` an element
 * ref, `fill` a ref), never raw Playwright or JavaScript. That is what keeps the
 * agent controllable and its failures diagnosable.
 */
export interface ToolDefinition<Args extends object = Record<string, unknown>> {
  name: string;
  description: string;
  actionKind: ActionKind;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  handler: (args: Args, ctx: ToolContext) => Promise<string>;
  /** Extracts the element ref / URL shown in the action log. */
  target?: (args: Args) => string | undefined;
  /** Extracts the value shown in the action log. */
  value?: (args: Args) => string | undefined;
  /** Detects an *expected* negative outcome (e.g. a failed assertion). */
  isFailure?: (output: string, args: Args) => boolean;
}

/** Add a file to the run's artifact list and return its URL-relative path. */
export function addArtifact(
  ctx: ToolContext,
  absolutePath: string,
  kind: ArtifactKind,
  label?: string,
): string {
  const relative = toArtifactPath(ctx.artifactsRoot, absolutePath);
  ctx.recorder.addArtifact({ kind, path: relative, label, createdAt: Date.now() });
  return relative;
}

/** Refresh the snapshot after a mutation and return a model-readable result. */
export async function observe(ctx: ToolContext, heading: string): Promise<string> {
  const snapshot = await ctx.session.snapshot();
  return `${heading}\n\n${snapshot}`;
}
