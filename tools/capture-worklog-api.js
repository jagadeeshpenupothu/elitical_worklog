import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";

const BASE_URL = (process.env.ELITICAL_BASE_URL || "https://elitical.sayukth.com").replace(/\/$/, "");
const START_URL = process.env.ELITICAL_WORKLOG_CAPTURE_URL || `${BASE_URL}/docket`;
const STORAGE_STATE = process.env.ELITICAL_STORAGE_STATE_PATH || ".elitical/storage-state.json";
const CAPTURE_DIR = ".elitical/captures/worklog";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isApiUrl(url) {
  return url.includes("/api/");
}

function safeJsonParse(value) {
  if (!value || !String(value).trim()) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function redactBody(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactBody);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /password|authorization|cookie|s-jwt-token/i.test(key)
        ? "[captured-secret-redacted]"
        : redactBody(entry),
    ])
  );
}

function redactBodyText(value, parsedJson) {
  if (parsedJson) {
    return JSON.stringify(redactBody(parsedJson));
  }

  return String(value || "")
    .replace(/("password"\s*:\s*)"[^"]*"/gi, '$1"[captured-secret-redacted]"')
    .replace(/(password=)[^&\s]*/gi, "$1[captured-secret-redacted]");
}

function queryParams(url) {
  const parsed = new URL(url);

  return Object.fromEntries(parsed.searchParams.entries());
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function eventFileName(index, event) {
  const parsed = new URL(event.url);
  const endpoint = parsed.pathname
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return `${String(index + 1).padStart(3, "0")}_${event.method}_${endpoint || "api"}.json`;
}

async function main() {
  const captureRoot = path.join(CAPTURE_DIR, nowStamp());
  const requestsDir = path.join(captureRoot, "requests");
  const responsesDir = path.join(captureRoot, "responses");
  const events = [];
  const requestIndex = new Map();

  await fs.mkdir(requestsDir, { recursive: true });
  await fs.mkdir(responsesDir, { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.ELITICAL_HEADLESS === "true",
  });
  const contextOptions = (await fileExists(STORAGE_STATE))
    ? { storageState: STORAGE_STATE }
    : {};
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on("request", (request) => {
    if (!isApiUrl(request.url())) return;

    const postBody = request.postData() || "";
    const postJson = safeJsonParse(postBody);
    const event = {
      id: `${Date.now()}-${events.length + 1}`,
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      query: queryParams(request.url()),
      status: null,
      requestBody: redactBodyText(postBody, postJson),
      requestJson: redactBody(postJson),
      responseBody: "",
      responseJson: null,
      requestSizeBytes: byteLength(postBody),
      responseSizeBytes: 0,
    };

    requestIndex.set(request, event);
    events.push(event);
    console.log(`[api] ${event.method} ${event.url}`);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const event = requestIndex.get(request);

    if (!event) return;

    let body = "";

    try {
      body = await response.text();
    } catch (error) {
      body = `[body unavailable: ${error instanceof Error ? error.message : String(error)}]`;
    }

    const responseJson = safeJsonParse(body);

    event.status = response.status();
    event.responseBody = body;
    event.responseJson = redactBody(responseJson);
    event.responseSizeBytes = byteLength(body);

    console.log(`[api] ${event.method} ${event.url} -> ${event.status}`);
  });

  console.log(`Opening ${START_URL}`);
  console.log("Recording every /api/ request and response.");
  console.log("Create the worklog in Elitical, then press Enter here to stop recording.");
  console.log(`Capture output directory: ${captureRoot}`);

  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (!process.stdin.isTTY) {
    console.log("This recorder must be run from an interactive terminal so Enter can stop the capture.");
    console.log("Press Ctrl+C to stop this non-interactive run.");
    await new Promise(() => {});
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await rl.question("Press Enter to stop capture...");
  rl.close();

  await page.waitForTimeout(1_000);
  await context.storageState({ path: STORAGE_STATE });

  for (const [index, event] of events.entries()) {
    const fileName = eventFileName(index, event);

    await writeJson(path.join(requestsDir, fileName), {
      timestamp: event.timestamp,
      method: event.method,
      url: event.url,
      status: event.status,
      requestBody: event.requestBody,
      requestJson: event.requestJson,
      requestSizeBytes: event.requestSizeBytes,
    });
    await writeJson(path.join(responsesDir, fileName), {
      timestamp: event.timestamp,
      method: event.method,
      url: event.url,
      status: event.status,
      responseBody: event.responseBody,
      responseJson: event.responseJson,
      responseSizeBytes: event.responseSizeBytes,
    });
  }

  await writeJson(path.join(captureRoot, "api-events.json"), events);

  console.log(`Saved event timeline: ${path.join(captureRoot, "api-events.json")}`);
  console.log(`Saved request files: ${requestsDir}`);
  console.log(`Saved response files: ${responsesDir}`);

  await browser.close();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
