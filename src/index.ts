#!/usr/bin/env node
import * as path from "node:path";
import { runTest } from "./agent/runner";
import { config } from "./config";
import { summarizeRun } from "./test-run/artifacts";
import type { RunEvent, TestAction } from "./types";

interface CliArgs {
  url?: string;
  instruction?: string;
  headless?: boolean;
  steps?: number;
  video?: boolean;
  help?: boolean;
}

const USAGE = `
web-test-agent - run a natural-language test against a real website

Usage
  npm run agent -- --url <url> --instruction "<instruction>" [options]

Options
  --url <url>              Target URL (required)
  --instruction <text>     What to test, in plain English (required)
  --headed                 Show the browser window (default: headless)
  --steps <n>              Max agent steps (default: ${config.agent.maxSteps})
  --no-video               Disable video recording
  --help                   Show this message

Example
  npm run agent -- \\
    --url http://localhost:3000/demo \\
    --instruction "Log in as test@example.com / password123, create a project called 'AI Test', and verify it appears in the list."
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--url":
        args.url = argv[++i];
        break;
      case "--instruction":
      case "-i":
        args.instruction = argv[++i];
        break;
      case "--headed":
        args.headless = false;
        break;
      case "--headless":
        args.headless = true;
        break;
      case "--steps":
        args.steps = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--no-video":
        args.video = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function printEvent(event: RunEvent): void {
  switch (event.type) {
    case "action": {
      const action = event.action;
      const mark = action.result === "success" ? "\u2713" : "\u2717";
      const target = action.target ? ` ${action.target}` : "";
      const value = action.value !== undefined ? ` = ${JSON.stringify(truncate(action.value))}` : "";
      const detail = action.error ? ` -- ${action.error}` : "";
      process.stdout.write(
        `  ${String(action.index).padStart(2, " ")} ${mark} ${describe(action)}${target}${value} (${action.durationMs}ms)${detail}\n`,
      );
      break;
    }
    case "assistant":
      process.stdout.write(`\n  [agent] ${truncate(event.text, 400)}\n\n`);
      break;
    case "error":
      process.stdout.write(`\n  !! ${event.message}\n`);
      break;
    default:
      break;
  }
}

function describe(action: TestAction): string {
  return action.tool.replace(/^browser_/, "");
}

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url || !args.instruction) {
    process.stdout.write(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const run = await runTest({
    url: args.url,
    instruction: args.instruction,
    headless: args.headless ?? config.browser.headless,
    maxSteps: args.steps ?? config.agent.maxSteps,
    recordVideo: args.video ?? config.browser.recordVideo,
    onEvent: printEvent,
  });

  process.stdout.write(`\n${"=".repeat(72)}\n`);
  process.stdout.write(`${run.status.toUpperCase()}  ${run.result?.summary ?? run.error ?? ""}\n`);
  process.stdout.write(`${summarizeRun(run)}\n`);

  if (run.result?.steps.length) {
    process.stdout.write("\nSteps\n");
    for (const step of run.result.steps) process.stdout.write(`  - ${step}\n`);
  }

  if (run.artifacts.length) {
    process.stdout.write("\nArtifacts\n");
    for (const artifact of run.artifacts) {
      process.stdout.write(`  ${artifact.kind.padEnd(10)} ${path.join(config.artifactsDir, artifact.path)}\n`);
    }
  }

  process.stdout.write(`${"=".repeat(72)}\n`);

  process.exit(run.status === "passed" ? 0 : 1);
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
