import { chromium } from "playwright";
import fs from "node:fs/promises";

const DOCKET_URL = "https://elitical.sayukth.com/docket";
const STORAGE_STATE = ".elitical/storage-state.json";
const REQUEST_FILE = ".elitical/issuesboard-request.json";
const RESPONSE_FILE = ".elitical/issuesboard-response.json";
const TIMEOUT_MS = 60000;

function isIssuesBoardPostRequest(request) {
  return (
    request.method() === "POST" &&
    request.url().includes("/api/1/IssuesBoard")
  );
}

function parseJsonBody(body) {
  if (!body.trim()) return null;

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeout);
  });
}

async function waitForDocketSurface(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUT_MS });

  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // Flutter pages can keep long-lived work alive; the IssuesBoard wait is the real gate.
  }

  await page.waitForFunction(
    () => document.body && document.body.textContent.trim().length > 0,
    null,
    { timeout: TIMEOUT_MS }
  );
}

await fs.mkdir(".elitical", { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: STORAGE_STATE,
});
const page = await context.newPage();

const issuesBoardRequestPromise = page.waitForRequest(isIssuesBoardPostRequest, {
  timeout: TIMEOUT_MS,
});

console.log(`Opening ${DOCKET_URL}`);
await page.goto(DOCKET_URL, {
  waitUntil: "domcontentloaded",
  timeout: TIMEOUT_MS,
});

await waitForDocketSurface(page);

let request;
try {
  request = await issuesBoardRequestPromise;
} catch (error) {
  await browser.close();
  throw new Error(
    `Timed out after ${TIMEOUT_MS / 1000}s waiting for the browser to issue POST /api/1/IssuesBoard. ` +
      `Refresh the saved session with refresh-session.js if the docket page is not authenticated.`,
    { cause: error }
  );
}

let response;
try {
  response = await withTimeout(
    request.response(),
    TIMEOUT_MS,
    "IssuesBoard response"
  );
} catch (error) {
  await browser.close();
  throw new Error(
    `The browser issued POST /api/1/IssuesBoard, but no matching response arrived within ` +
      `${TIMEOUT_MS / 1000}s.`,
    { cause: error }
  );
}

if (!response) {
  await browser.close();
  throw new Error("The browser issued POST /api/1/IssuesBoard, but Playwright returned no response.");
}

const postBody = request.postData() || "";
const responseBody = await response.text();

await fs.writeFile(
  REQUEST_FILE,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      postBody,
      postJson: parseJsonBody(postBody),
    },
    null,
    2
  )}\n`
);

await fs.writeFile(
  RESPONSE_FILE,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      url: response.url(),
      status: response.status(),
      headers: response.headers(),
      body: responseBody,
      json: parseJsonBody(responseBody),
    },
    null,
    2
  )}\n`
);

console.log(`Captured IssuesBoard request: ${REQUEST_FILE}`);
console.log(`Captured IssuesBoard response: ${RESPONSE_FILE}`);

await browser.close();
