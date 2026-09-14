import * as path from "node:path";
import "dotenv/config";

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    timeoutMs: int(process.env.LLM_TIMEOUT_MS, 120_000),
  },
  server: {
    port: int(process.env.PORT, 3000),
  },
  browser: {
    headless: bool(process.env.HEADLESS, true),
    recordVideo: bool(process.env.RECORD_VIDEO, true),
    slowMo: int(process.env.SLOW_MO, 0),
  },
  agent: {
    maxSteps: int(process.env.MAX_STEPS, 40),
  },
  /** Root folder for screenshots, videos and result JSON. */
  artifactsDir: process.env.ARTIFACTS_DIR
    ? path.resolve(process.env.ARTIFACTS_DIR)
    : path.resolve(process.cwd(), "artifacts"),
  /** Folder holding the bundled demo app used for smoke tests. */
  demoDir: path.resolve(__dirname, "..", "demo-app"),
} as const;

export function requireApiKey(): string {
  if (!config.llm.apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key, " +
        "or export DEEPSEEK_API_KEY=... before running.",
    );
  }
  return config.llm.apiKey;
}
