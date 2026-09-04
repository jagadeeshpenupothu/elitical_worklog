import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const localCacheClientSource = readFileSync(
  new URL("../src/services/localCacheClient.js", import.meta.url),
  "utf8"
);
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const syncClientSource = readFileSync(new URL("../src/services/syncClient.js", import.meta.url), "utf8");

assert.match(
  localCacheClientSource,
  /loadLocalGraphCache\(\{\s*skipBackgroundSync = true\s*\} = \{\}\)/,
  "Local cache client must default graph cache reads to skip background sync"
);

assert.match(
  appSource,
  /loadLocalGraphCache\(\{\s*skipBackgroundSync: true,\s*\}\)/,
  "Application startup must request a read-only local cache load"
);

assert.match(
  serverSource,
  /const allowBackgroundSync =\s*!skipBackgroundSync && url\.searchParams\.get\("backgroundSync"\) === "1";/,
  "The /api/cache endpoint must require an explicit backgroundSync=1 opt-in"
);

assert.match(
  serverSource,
  /if \(allowBackgroundSync\) syncService\.startBackground\(\{ providerId: "elitical" \}\);/,
  "The /api/cache endpoint must not start background sync unless the explicit opt-in is present"
);

assert.doesNotMatch(
  serverSource,
  /if \(!skipBackgroundSync\) syncService\.startBackground\(\{ providerId: "elitical" \}\);/,
  "A plain /api/cache request must not start background sync"
);

assert.match(
  serverSource,
  /const allowRebuildFromElitical =\s*!skipBackgroundSync && url\.searchParams\.get\("rebuildFromElitical"\) === "1";/,
  "The /api/cache endpoint must require an explicit rebuildFromElitical=1 opt-in before rebuilding from Elitical"
);

assert.match(
  serverSource,
  /if \(storageInitialization\.resetDetected && allowRebuildFromElitical\)/,
  "Cache bootstrap rebuild must not run from a normal local cache read"
);

assert.match(
  serverSource,
  /if \(req\.method === "POST" && url\.pathname === "\/api\/sync"\)[\s\S]*syncService\.run\(\{ providerId \}\)/,
  "Explicit Sync from Elitical must remain available through POST /api/sync"
);

assert.match(
  serverSource,
  /if \(body\.direction === "to-elitical" \|\| body\.action === "sync_pending"\)[\s\S]*syncPendingToElitical\(\)/,
  "Explicit Sync to Elitical must remain available through POST /api/sync"
);

assert.match(
  syncClientSource,
  /fetchBackend\(syncEndpoint\(\), \{[\s\S]*method: "POST"[\s\S]*body: JSON\.stringify\(\{ provider \}\)/,
  "The frontend explicit inbound Sync action must still call POST /api/sync"
);

assert.match(
  syncClientSource,
  /fetchBackend\(syncEndpoint\(\), \{[\s\S]*method: "POST"[\s\S]*direction: "to-elitical"/,
  "The frontend explicit outbound Sync action must still call POST /api/sync"
);

console.log("Local cache no-auto-sync verification PASS");
