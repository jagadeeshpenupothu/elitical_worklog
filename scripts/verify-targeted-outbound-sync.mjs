import assert from "node:assert/strict";
import fs from "node:fs/promises";

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} must exist.`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `${startMarker} must exist.`);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}.`);

  return source.slice(start, end);
}

const outboundSync = extractFunction(serverSource, "syncPendingToElitical");
const createReconciliation = extractBetween(
  serverSource,
  "async function reconcileEmptyCreateResponse",
  "function validateCreateDocketPayload"
);

assert.equal(
  outboundSync.includes("syncService.run"),
  false,
  "Sync to Elitical must not run the full inbound SyncService import."
);
assert.equal(
  createReconciliation.includes("syncService.run"),
  false,
  "Empty create reconciliation must not run the full inbound SyncService import."
);
assert.equal(
  createReconciliation.includes("getIssues("),
  true,
  "Empty create reconciliation should use a targeted IssuesBoard/list read."
);
assert.equal(
  outboundSync.includes("getWorklogs("),
  false,
  "Sync to Elitical must not fetch Worklogs."
);
assert.equal(
  outboundSync.includes("fullSyncRun: false"),
  true,
  "Sync to Elitical summary must explicitly report no full sync."
);
assert.match(
  serverSource,
  /else\s*\{\s*sendJson\(res,\s*200,\s*await syncService\.run\(\{ providerId \}\)\);/s,
  "Sync from Elitical must retain the full/incremental inbound import path."
);

console.log("Targeted outbound sync static verification PASS");
