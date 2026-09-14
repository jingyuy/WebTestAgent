import * as fs from "node:fs/promises";
import * as path from "node:path";
import express from "express";
import { runTest } from "./agent/runner";
import { config } from "./config";
import { DEMO_URL, scenarios } from "./scenarios";
import { newRunId } from "./test-run/artifacts";
import type { RunEvent, TestRun } from "./types";

interface RunHandle {
  id: string;
  events: RunEvent[];
  subscribers: Set<(event: RunEvent) => void>;
  done: boolean;
  run?: TestRun;
}

const runs = new Map<string, RunHandle>();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Static UI, the bundled demo app, and recorded artifacts.
app.use(express.static(path.join(__dirname, "ui")));
app.use("/demo", express.static(config.demoDir));
app.use("/artifacts", express.static(config.artifactsDir));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: config.llm.model,
    llmConfigured: Boolean(config.llm.apiKey),
    artifactsDir: config.artifactsDir,
  });
});

/** Pre-built benchmark corpus, surfaced in the UI as one-click examples. */
app.get("/api/scenarios", (_req, res) => {
  res.json({
    demoUrl: DEMO_URL,
    scenarios: scenarios.map(({ name, url, instruction, expected }) => ({
      name,
      url,
      instruction,
      expected,
    })),
  });
});

app.post("/api/runs", (req, res) => {
  const body = req.body as {
    url?: string;
    instruction?: string;
    headless?: boolean;
    maxSteps?: number;
    recordVideo?: boolean;
  };

  const url = body.url?.trim();
  const instruction = body.instruction?.trim();

  if (!url || !instruction) {
    res.status(400).json({ error: "Both `url` and `instruction` are required." });
    return;
  }
  if (!config.llm.apiKey) {
    res.status(400).json({
      error: "DEEPSEEK_API_KEY is not configured. Add it to .env and restart the server.",
    });
    return;
  }

  // Allow the UI to submit app-relative URLs such as `/demo/`.
  const targetUrl = url.startsWith("/")
    ? `${req.protocol}://${req.get("host")}${url}`
    : url;

  const id = newRunId();
  const handle: RunHandle = { id, events: [], subscribers: new Set(), done: false };
  runs.set(id, handle);

  res.status(202).json({ id, eventsUrl: `/api/runs/${id}/events` });

  const publish = (event: RunEvent): void => {
    handle.events.push(event);
    for (const subscriber of handle.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* ignore broken streams */
      }
    }
  };

  void runTest({
    url: targetUrl,
    instruction,
    runId: id,
    headless: body.headless ?? config.browser.headless,
    maxSteps: body.maxSteps ?? config.agent.maxSteps,
    recordVideo: body.recordVideo ?? config.browser.recordVideo,
    onEvent: publish,
  })
    .then((run) => {
      handle.run = run;
    })
    .catch((error: Error) => {
      publish({ type: "error", message: error.message });
    })
    .finally(() => {
      handle.done = true;
    });
});

app.get("/api/runs/:id/events", (req, res) => {
  const handle = runs.get(req.params.id);
  if (!handle) {
    res.status(404).json({ error: "Unknown run." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  // Replay everything that happened before this client connected.
  for (const event of handle.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (handle.done) {
    res.write("event: end\ndata: {}\n\n");
    res.end();
    return;
  }

  const subscriber = (event: RunEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  handle.subscribers.add(subscriber);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    handle.subscribers.delete(subscriber);
  });
});

app.get("/api/runs/:id", (req, res) => {
  const handle = runs.get(req.params.id);
  if (!handle?.run) {
    res.status(404).json({ error: "Run not found or still in progress." });
    return;
  }
  res.json(handle.run);
});

app.get("/api/runs", async (_req, res) => {
  res.json(await listRuns());
});

/** Read finished runs from disk so history survives a server restart. */
async function listRuns(): Promise<Array<Partial<TestRun> & { running?: boolean }>> {
  const results: Array<Partial<TestRun> & { running?: boolean }> = [];

  for (const handle of runs.values()) {
    if (!handle.done) {
      results.push({ id: handle.id, status: "running", running: true, actions: [], artifacts: [] });
    }
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(config.artifactsDir);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (runs.get(entry)?.done) continue;
    try {
      const raw = await fs.readFile(path.join(config.artifactsDir, entry, "result.json"), "utf8");
      const run = JSON.parse(raw) as TestRun;
      results.push(run);
    } catch {
      /* not a run directory */
    }
  }

  return results.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 50);
}

app.listen(config.server.port, () => {
  const base = `http://localhost:${config.server.port}`;
  process.stdout.write(`web-test-agent listening on ${base}\n`);
  process.stdout.write(`  UI        ${base}/\n`);
  process.stdout.write(`  demo app  ${base}/demo/\n`);
  process.stdout.write(`  model     ${config.llm.model}\n`);
  if (!config.llm.apiKey) {
    process.stdout.write("  !! DEEPSEEK_API_KEY is not set - runs will be rejected. See .env.example\n");
  }
});
