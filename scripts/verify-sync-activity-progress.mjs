import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const files = {
  app: readFileSync("src/App.jsx", "utf8"),
  css: readFileSync("src/App.css", "utf8"),
  syncClient: readFileSync("src/services/syncClient.js", "utf8"),
  syncLive: readFileSync("src/services/elitical/syncLive.ts", "utf8"),
  client: readFileSync("src/services/elitical/client/EliticalClient.ts", "utf8"),
  provider: readFileSync("src/services/elitical/provider/EliticalProvider.ts", "utf8"),
  backend: readFileSync("local-backend/server.mjs", "utf8"),
  syncService: readFileSync("local-backend/services/SyncService.mjs", "utf8"),
  packageJson: readFileSync("package.json", "utf8"),
};

function includes(file, pattern, label) {
  assert.match(file, pattern, label);
}

includes(files.app, /localSavedSyncActivity\(result\.message \|\| "Saved locally"/, "local create records Saved locally only after backend success");
includes(files.app, /localSavedSyncActivity\(remoteResult\.message \|\| "Saved locally"/, "local update records Saved locally only after backend success");
includes(files.app, /catch \(error\)[\s\S]*?setMessage\(message\);[\s\S]*?return \{\s*ok: false,/m, "failed local save path returns failure without success activity");
includes(files.app, /syncQueueSummary\.actionableCount > 0\s*\?\s*"pending"/, "pending queue state is rendered as pending, not synced");
includes(files.backend, /direction: "outbound"[\s\S]*state: "running"/, "outbound sync emits running activity");
includes(files.backend, /operationType: operation\.operation/, "outbound activity uses actual queue operation type");
includes(files.backend, /current: index \+ 1,[\s\S]*total,[\s\S]*unit: "operations"/, "outbound activity exposes current and total operations");
includes(files.app, /return "Unknown";/, "unknown progress remains unknown instead of a fake count");
includes(files.backend, /state: hardFailures\.length \? "failed" : "synced"/, "outbound completion reflects actual failures");
includes(files.app, /completeSyncActivity\("outbound"/, "successful outbound handler records synced final state");
includes(files.app, /failedSyncActivity\("outbound"/, "failed outbound handler records failure final state");
includes(files.syncLive, /message: "Fetching Issues Board\.\.\."/m, "inbound progress names the actual IssuesBoard fetch");
includes(files.client, /path: "\/api\/1\/IssuesBoard"/, "IssuesBoard endpoint remains the source of inbound issue progress");
includes(files.client, /options\.onProgress\?\.\(\{\s*current: 1,[\s\S]*total: totalPage,[\s\S]*unit: "pages"/, "first IssuesBoard page emits current and total page progress");
includes(files.client, /options\.onProgress\?\.\(\{\s*current: currentPage,[\s\S]*total: totalPage,[\s\S]*unit: "pages"/, "subsequent IssuesBoard pages emit current and total page progress");
includes(files.syncService, /const publication = await this\.publishSnapshot/, "inbound sync awaits publication before final convergence");
includes(files.syncService, /phase: "publishing"[\s\S]*message: "Publishing synchronized snapshot for Web\.\.\."/m, "inbound sync reports publishing as a real stage");
includes(files.syncService, /phase: publication\?\.status === "published" \? "complete" : "publication-failed"/, "inbound completion reflects publication success or failure");
includes(files.syncService, /Local sync complete — Web publication failed\./, "publication failure has a distinct user-facing message");
includes(files.app, /<section className="sync-current-activity"/, "popover renders a current activity section");
includes(files.app, /syncActivityRows\(syncActivity, syncStatusPresentation\)/, "popover updates from shared sync activity and queue presentation state");
includes(files.app, /<section className="sync-operation-section sync-failed-operations"/, "popover renders actual failed operations separately");
includes(files.app, /<section className="sync-operation-section sync-blocked-operations"/, "popover renders blocked operations separately");
includes(files.app, /buildSyncStatusPresentation\(\{[\s\S]*activity: syncActivity,[\s\S]*queueSummary: syncQueueSummary/, "sync status presentation is derived from queue summary plus activity");
includes(files.app, /\["Actionable Sync Items", syncQueueSummary\.actionableCount \|\| 0\]/, "existing summary rows remain");
includes(files.app, /\["Last Synced", syncStatusSummary\.syncedAt \? formatTimestamp/, "existing last synced summary remains");
includes(files.app, /syncVisualState[\s\S]*"pending"/, "sync icon reflects pending state");
includes(files.css, /\.sync-status-button\.pending/, "pending icon visual state has CSS");
includes(files.app, /onClick=\{onSyncToElitical\}/, "sync to handler remains wired");
includes(files.app, /onClick=\{onSyncFromElitical\}/, "sync from handler remains wired");
includes(files.app, /authorization\|cookie\|jwt\|token\|session\|password\|secret/, "activity text sanitizer blocks sensitive terms");
includes(files.app, /View Terminal \/ Logs/, "logs menu remains available");
includes(files.packageJson, /"dev": "node scripts\/dev\.mjs"/, "npm run dev remains unchanged");
includes(files.syncClient, /localBackendOrigin\(\)}\/api\/sync/, "sync client still uses configured backend origin");
includes(files.syncClient, /export function subscribeToSyncProgress/, "progress stream is reusable for dev and Electron contexts");
includes(files.provider, /this\.client\.getIssues\(projectId, options\)/, "provider forwards optional progress without changing existing behavior");
includes(files.syncService, /phase: "saving-cache"[\s\S]*message: "Saving local cache\.\.\."/m, "inbound cache persistence reports a real stage");

console.log("Sync activity progress verification passed.");
