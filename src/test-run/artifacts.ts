import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestRun } from "../types";

export interface RunDirs {
  runId: string;
  artifactsRoot: string;
  runDir: string;
  screenshotsDir: string;
  videosDir: string;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export async function createRunDirs(artifactsRoot: string, runId: string): Promise<RunDirs> {
  const runDir = path.join(artifactsRoot, runId);
  const screenshotsDir = path.join(runDir, "screenshots");
  const videosDir = path.join(runDir, "videos");
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(videosDir, { recursive: true });
  return { runId, artifactsRoot, runDir, screenshotsDir, videosDir };
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Path relative to the artifacts root, i.e. what the UI can fetch over HTTP. */
export function toArtifactPath(artifactsRoot: string, absolutePath: string): string {
  return path.relative(artifactsRoot, absolutePath).split(path.sep).join("/");
}

/** Human-readable single-line summary of a finished run. */
export function summarizeRun(run: TestRun): string {
  const seconds = ((run.durationMs ?? 0) / 1000).toFixed(1);
  const passed = run.actions.filter((a) => a.result === "success").length;
  return `${run.status.toUpperCase()} in ${seconds}s — ${passed}/${run.actions.length} actions ok — ${run.artifacts.length} artifacts`;
}
