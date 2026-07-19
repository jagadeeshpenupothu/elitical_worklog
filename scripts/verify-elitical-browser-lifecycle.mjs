import assert from "node:assert/strict";
import fs from "node:fs/promises";

const authSource = await fs.readFile(
  new URL("../src/services/elitical/auth/EliticalAuthService.ts", import.meta.url),
  "utf8"
);
const clientSource = await fs.readFile(
  new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url),
  "utf8"
);
const providerSource = await fs.readFile(
  new URL("../src/services/elitical/provider/EliticalProvider.ts", import.meta.url),
  "utf8"
);
const syncLiveSource = await fs.readFile(
  new URL("../src/services/elitical/syncLive.ts", import.meta.url),
  "utf8"
);
const serverSource = await fs.readFile(
  new URL("../local-backend/server.mjs", import.meta.url),
  "utf8"
);
const syncServiceSource = await fs.readFile(
  new URL("../local-backend/services/SyncService.mjs", import.meta.url),
  "utf8"
);

function extractFunction(source, name, { async = true } = {}) {
  const marker = `${async ? "async " : ""}function ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} must exist.`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

function extractMethod(source, name) {
  const match = new RegExp(`(?:private\\s+)?async\\s+${name}\\s*\\(`).exec(source);

  assert.ok(match, `${name} must exist.`);

  const paramsEnd = source.indexOf(")", match.index);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
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

const authCloseRuntime = extractMethod(authSource, "closeRuntime");
const serverAcquire = extractFunction(serverSource, "acquireSdkProvider");
const serverClose = extractFunction(serverSource, "closeSdkProvider");
const outboundSync = extractFunction(serverSource, "syncPendingToElitical");
const createRemote = extractFunction(serverSource, "createEliticalDocket");
const createReconciliation = extractBetween(
  serverSource,
  "async function reconcileEmptyCreateResponse",
  "function validateCreateDocketPayload"
);
const localSave = extractFunction(serverSource, "updateLocalDocket");
const syncProviderFactory = extractFunction(syncServiceSource, "createEliticalSyncProvider", {
  async: false,
});
const syncServiceRun = extractBetween(
  syncServiceSource,
  "async run({ providerId = \"elitical\" } = {})",
  "startBackground"
);

assert.match(authSource, /async close\(\): Promise<void> \{\s*await this\.closeRuntime\(\{ persistSession: true \}\);/s);
assert.match(authCloseRuntime, /await this\.persistSession\(context\);/);
assert.match(authCloseRuntime, /await page\?\.close\(\);/);
assert.match(authCloseRuntime, /await context\?\.close\(\);/);
assert.match(authCloseRuntime, /await browser\?\.close\(\);/);
assert.match(clientSource, /async close\(\): Promise<void> \{\s*await this\.authService\.close\(\);/s);
assert.match(providerSource, /async close\(\): Promise<void> \{\s*await this\.client\.close\(\);/s);
assert.match(syncLiveSource, /finally\s*\{\s*await \(authService as unknown as ClosableAuthService\)\.close\(\);/s);

assert.match(serverSource, /let sdkProviderLeaseCount = 0;/);
assert.match(serverAcquire, /sdkProviderLeaseCount \+= 1;/);
assert.match(serverAcquire, /finally|release/);
assert.match(serverClose, /if \(!force && sdkProviderLeaseCount > 0\) return;/);
assert.match(serverClose, /sdkProviderPromise = null;/);
assert.match(serverClose, /await provider\?\.close\?\.\(\);/);

assert.match(outboundSync, /const sdkLease = await acquireSdkProvider\(\);/);
assert.match(outboundSync, /try\s*\{\s*const provider = sdkLease\.provider;/s);
assert.match(outboundSync, /finally\s*\{\s*await sdkLease\.release\(\);/s);
assert.match(outboundSync, /await reconcileCreatedRemoteId\(remotePayload, createdDocket,\s*\{\s*provider,/s);
assert.match(outboundSync, /await saveLocalGraph\(graph, \{ status: "queue-processed" \}\);/);

assert.match(createRemote, /const sdkLease = provider \? null : await acquireSdkProvider\(\);/);
assert.match(createRemote, /finally\s*\{\s*await sdkLease\?\.release\(\);/s);
assert.match(createReconciliation, /const sdkLease = provider \? null : await acquireSdkProvider\(\);/);
assert.match(createReconciliation, /finally\s*\{\s*await sdkLease\?\.release\(\);/s);

assert.equal(
  localSave.includes("sdkProvider(") || localSave.includes("acquireSdkProvider("),
  false,
  "Normal local Save must not acquire the SDK provider or open Chromium."
);

assert.match(syncServiceSource, /async closeProviders\(\)/);
assert.match(syncServiceRun, /finally\s*\{\s*this\.syncInProgress = false;/s);
assert.match(syncProviderFactory, /let sdkProviderLeaseCount = 0;/);
assert.match(syncProviderFactory, /async function withSdkProvider\(operation\)/);
assert.match(syncProviderFactory, /await sdkLease\.release\(\);/);
assert.match(syncProviderFactory, /async close\(\) \{\s*await closeSdkProvider\(\{ force: true \}\);/s);
assert.match(syncProviderFactory, /return importEliticalLiveToNormalized\(/);

assert.match(serverSource, /process\.on\("SIGINT"/);
assert.match(serverSource, /process\.on\("SIGTERM"/);
assert.match(serverSource, /await Promise\.all\(\[\s*closeSdkProvider\(\{ force: true \}\),\s*syncService\.closeProviders\(\),/s);

console.log("Elitical browser lifecycle static verification PASS");
