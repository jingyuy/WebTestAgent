/**
 * Benchmark runner.
 *
 *   npm run bench                          # against http://localhost:3000
 *   npm run bench -- --base https://x.com  # against another origin
 *   npm run bench -- --only "Login"        # filter by scenario name
 *
 * Reports the metrics that actually matter for a testing product: task success
 * rate, and — most importantly — the false PASS / false FAIL rates.
 */
import * as path from "node:path";
import { runTest } from "./agent/runner";
import { config } from "./config";
import { scenarios, type Scenario } from "./scenarios";
import { writeJson } from "./test-run/artifacts";
import type { TestRun } from "./types";

interface BenchResult {
  scenario: string;
  expected: "passed" | "failed";
  actual: string;
  correct: boolean;
  durationMs: number;
  actions: number;
  failedActions: number;
  tokens: number;
  runId: string;
}

function parseArgs(argv: string[]): { base?: string; only?: string } {
  const args: { base?: string; only?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") args.base = argv[++i];
    if (argv[i] === "--only") args.only = argv[++i];
  }
  return args;
}

function resolve(base: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base.replace(/\/+$/, "")}${url}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base ?? `http://localhost:${config.server.port}`;

  const selected: Scenario[] = args.only
    ? scenarios.filter((scenario) => scenario.name.toLowerCase().includes(args.only!.toLowerCase()))
    : scenarios;

  if (selected.length === 0) {
    process.stdout.write("No scenarios matched.\n");
    process.exit(1);
  }

  process.stdout.write(`Benchmarking ${selected.length} scenario(s) against ${base}\n\n`);

  const results: BenchResult[] = [];

  for (const [index, scenario] of selected.entries()) {
    process.stdout.write(`[${index + 1}/${selected.length}] ${scenario.name}\n`);

    const run: TestRun = await runTest({
      url: resolve(base, scenario.url),
      instruction: scenario.instruction,
      onEvent: (event) => {
        if (event.type === "action") {
          const mark = event.action.result === "success" ? "\u2713" : "\u2717";
          process.stdout.write(`    ${mark} ${event.action.tool} ${event.action.target ?? ""}\n`);
        }
      },
    });

    const correct = run.status === scenario.expected;
    results.push({
      scenario: scenario.name,
      expected: scenario.expected,
      actual: run.status,
      correct,
      durationMs: run.durationMs ?? 0,
      actions: run.actions.length,
      failedActions: run.actions.filter((action) => action.result === "failure").length,
      tokens: run.usage?.totalTokens ?? 0,
      runId: run.id,
    });

    process.stdout.write(
      `    -> ${run.status.toUpperCase()} (expected ${scenario.expected.toUpperCase()}) ${
        correct ? "OK" : "MISMATCH"
      }\n\n`,
    );
  }

  const total = results.length;
  const correct = results.filter((result) => result.correct).length;
  const falsePass = results.filter((r) => r.expected === "failed" && r.actual === "passed").length;
  const falseFail = results.filter((r) => r.expected === "passed" && r.actual !== "passed").length;
  const negative = results.filter((r) => r.expected === "failed").length;

  const summary = {
    generatedAt: new Date().toISOString(),
    base,
    total,
    correct,
    taskSuccessRate: total ? correct / total : 0,
    falsePassRate: negative ? falsePass / negative : 0,
    falseFailRate: total - negative ? falseFail / (total - negative) : 0,
    avgActions: total ? results.reduce((sum, r) => sum + r.actions, 0) / total : 0,
    avgDurationMs: total ? results.reduce((sum, r) => sum + r.durationMs, 0) / total : 0,
    totalTokens: results.reduce((sum, r) => sum + r.tokens, 0),
    results,
  };

  const file = path.join(config.artifactsDir, `bench-${Date.now()}.json`);
  await writeJson(file, { ...summary, artifactPath: file });

  process.stdout.write(`${"=".repeat(72)}\n`);
  for (const result of results) {
    process.stdout.write(
      `${result.correct ? "OK  " : "FAIL"} ${result.scenario.padEnd(42)} expected=${result.expected.padEnd(
        6,
      )} actual=${result.actual}\n`,
    );
  }
  process.stdout.write(`${"=".repeat(72)}\n`);
  process.stdout.write(`task success rate : ${(summary.taskSuccessRate * 100).toFixed(1)}% (${correct}/${total})\n`);
  process.stdout.write(`false PASS rate   : ${(summary.falsePassRate * 100).toFixed(1)}% (${falsePass}/${negative})\n`);
  process.stdout.write(`false FAIL rate   : ${(summary.falseFailRate * 100).toFixed(1)}%\n`);
  process.stdout.write(`avg actions       : ${summary.avgActions.toFixed(1)}\n`);
  process.stdout.write(`avg duration      : ${(summary.avgDurationMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`total tokens      : ${summary.totalTokens}\n`);
  process.stdout.write(`report            : ${file}\n`);
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
