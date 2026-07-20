import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const cssSource = await fs.readFile(new URL("../src/App.css", import.meta.url), "utf8");
const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const logServiceSource = await fs.readFile(
  new URL("../local-backend/services/LogBufferService.mjs", import.meta.url),
  "utf8"
);
const logsClientSource = await fs.readFile(
  new URL("../src/services/logsClient.js", import.meta.url),
  "utf8"
);

assert.match(appSource, /className="global-icon-button profile-menu-button"/);
assert.match(appSource, /profileMenuOpen/);
assert.match(appSource, /View Terminal \/ Logs/);
assert.match(appSource, /LogViewerModal open=\{logsModalOpen\}/);
assert.match(appSource, /loadApplicationLogs/);
assert.match(appSource, /setEntries\(\[\]\)/);
assert.match(appSource, /slice\(-1000\)/);
assert.match(appSource, /handleLogScroll/);
assert.match(appSource, /distanceFromBottom <= 40/);
assert.match(appSource, /logs-latest-button/);
assert.match(appSource, /scrollToLatest/);

assert.match(appSource, /className="global-icon-button sync-action-button sync-action-button-upload"/);
assert.match(appSource, /onSyncToElitical=\{handleSyncToElitical\}/);
assert.match(appSource, /onClick=\{onSyncToElitical\}/);
assert.match(appSource, /className="global-icon-button sync-action-button sync-action-button-download"/);
assert.match(appSource, /onSyncFromElitical=\{handleSyncFromElitical\}/);
assert.match(appSource, /onClick=\{onSyncFromElitical\}/);
assert.match(appSource, /aria-label="Sync to Elitical"/);
assert.match(appSource, /aria-label="Sync from Elitical"/);
assert.match(appSource, /aria-busy=\{liveSyncState === "syncing"\}/);
assert.match(appSource, /syncQueueSummary\.actionableCount/);
assert.doesNotMatch(appSource, /className="sync-action-label"/);

assert.match(cssSource, /\.profile-menu/);
assert.match(cssSource, /\.logs-modal/);
assert.match(cssSource, /grid-template-rows: auto auto minmax\(0, 1fr\) auto/);
assert.match(cssSource, /\.logs-content/);
assert.match(cssSource, /\.logs-latest-button/);
assert.match(cssSource, /\.sync-action-button/);

assert.match(serverSource, /new LogBufferService\(\{ limit: 1000 \}\)/);
assert.match(serverSource, /logBuffer\.captureConsole\(console\)/);
assert.match(serverSource, /url\.pathname === "\/api\/logs"/);
assert.doesNotMatch(serverSource, /\/api\/logs[\s\S]{0,300}localData\.clear/);

assert.match(logServiceSource, /SECRET_KEY_PATTERN/);
assert.match(logServiceSource, /\[REDACTED\]/);
assert.match(logServiceSource, /this\.entries\.splice\(0, this\.entries\.length - this\.limit\)/);
assert.doesNotMatch(logServiceSource, /child_process|spawn|exec\(/);

assert.match(logsClientSource, /GET|fetch\(logsEndpoint/);
assert.doesNotMatch(logsClientSource, /method:\s*["']POST["']|DELETE|PUT/);

console.log("Profile menu, logs viewer, and sync icon UI verification PASS");
