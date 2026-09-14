/**
 * Browser-only smoke test — validates the Playwright + snapshot layer without
 * needing an LLM key.
 *
 *   npm run smoke                                   # against the bundled demo app
 *   npm run smoke -- https://example.com
 *   npm run smoke -- https://example.com --headed   # watch it happen
 */
import * as path from "node:path";
import { BrowserSession } from "./browser/session";
import { config } from "./config";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--headed");
  const headed = process.argv.includes("--headed");
  const target =
    args[0] ?? `http://localhost:${config.server.port}/demo/`;

  process.stdout.write(`Opening ${target} (headless=${!headed})\n\n`);

  const session = await BrowserSession.create({
    headless: !headed,
    screenshotsDir: path.join(config.artifactsDir, "smoke", "screenshots"),
    slowMo: config.browser.slowMo,
  });

  try {
    await session.goto(target);
    const snapshot = await session.snapshot();

    process.stdout.write(`${snapshot}\n\n`);

    const screenshot = await session.screenshot("smoke", false);
    process.stdout.write(`Screenshot: ${screenshot}\n`);

    if (session.refs.size === 0) {
      process.stderr.write("\nNo interactive elements found — the snapshot engine may be broken.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write(`\nOK — ${session.refs.size} interactive element(s) with fresh refs.\n`);
    }
  } finally {
    await session.close();
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
