import http from "node:http";
import { CacheService } from "./services/CacheService.mjs";
import { WorklogService } from "./services/WorklogService.mjs";

const DEFAULT_PORT = 3797;
const PORT = Number(process.env.LOCAL_BACKEND_PORT || DEFAULT_PORT);
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

let syncInProgress = false;
let lastProgress = null;
let backgroundSyncStarted = false;
const progressClients = new Set();
const cacheClients = new Set();
const cacheService = new CacheService();
const worklogService = new WorklogService();

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();

  if (!rawBody) return {};

  return JSON.parse(rawBody);
}

function sendProgress(progress) {
  lastProgress = {
    ...progress,
    emittedAt: new Date().toISOString(),
  };

  const event = `data: ${JSON.stringify(lastProgress)}\n\n`;

  progressClients.forEach((client) => {
    client.write(event);
  });
}

function sendCacheEvent(type, payload = {}) {
  const event = `event: ${type}\ndata: ${JSON.stringify({
    ...payload,
    emittedAt: new Date().toISOString(),
  })}\n\n`;

  cacheClients.forEach((client) => {
    client.write(event);
  });
}

function handleProgressStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": connected\n\n");

  if (lastProgress) {
    res.write(`data: ${JSON.stringify(lastProgress)}\n\n`);
  }

  progressClients.add(res);

  req.on("close", () => {
    progressClients.delete(res);
  });
}

function handleCacheEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": connected\n\n");

  cacheClients.add(res);

  req.on("close", () => {
    cacheClients.delete(res);
  });
}

function safeError(error) {
  return {
    message: error?.message || "Local backend error",
    status: error?.status || 0,
    endpoint: error?.endpoint || "",
  };
}

function seconds(ms = 0) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function timingLine(label, ms) {
  return `${label.padEnd(22, ".")} ${seconds(ms)}`;
}

function printTimingSummary(timings) {
  console.log("");
  console.log("Incremental Sync Timing");
  console.log("-------------------------------------");
  console.log(timingLine("Authentication", timings.authenticationMs));
  console.log(timingLine("Projects", timings.projectsMs));
  console.log(timingLine("Sprints", timings.sprintsMs));
  console.log(timingLine("IssuesBoard", timings.issuesBoardMs));
  console.log(timingLine("Comparison", timings.comparisonMs));
  console.log(timingLine("Detail requests", timings.detailRequestsMs));
  console.log(timingLine("Worklog import", timings.worklogImportMs));
  console.log(timingLine("Normalization", timings.normalizationMs));
  console.log(timingLine("Cache write", timings.cacheWriteMs));
  console.log("");
  console.log(timingLine("Total", timings.totalMs));
  console.log("-------------------------------------");
}

async function runLiveSync({ respond } = {}) {
  if (syncInProgress) {
    const payload = {
      error: "Elitical sync is already running.",
      message: "Please wait for the current sync to finish.",
    };

    if (respond) sendJson(respond, 409, payload);
    return null;
  }

  syncInProgress = true;
  sendProgress({ phase: "starting", message: "Starting Elitical sync..." });
  sendCacheEvent("sync-started", { syncInProgress: true });

  try {
    const syncStartedAt = Date.now();
    const { importEliticalLiveToNormalized } = await import(
      "../src/services/elitical/syncLive.ts"
    );
    const previousGraph = await cacheService.loadGraph();
    const previousMetadata = await cacheService.readMetadata();
    const cachedWorklogs = await worklogService.loadImportedWorklogs();
    const result = await importEliticalLiveToNormalized({
      writeOutput: false,
      onProgress: sendProgress,
      previousGraph,
      syncIndex: previousMetadata
        ? {
            lastSuccessfulSync: previousMetadata.lastSuccessfulSync,
            projectId: previousMetadata.projectId || previousMetadata.eliticalProjectId,
            dockets: previousMetadata.dockets || {},
          }
        : null,
      cachedWorklogs,
    });
    const cacheWriteStartedAt = Date.now();
    const cacheWrite = await cacheService.saveGraph(result.normalized, {
      syncedAt: result.syncedAt,
      syncIndex: result.syncIndex,
    });
    const worklogCacheWrite = await worklogService.saveImportedWorklogs(result.worklogs);
    const cacheWriteMs = Date.now() - cacheWriteStartedAt;
    const timings = {
      ...result.timings,
      cacheWriteMs,
      totalMs: Date.now() - syncStartedAt,
    };
    printTimingSummary(timings);
    const worklogUpload = await worklogService.uploadPending();
    const payload = {
      status: "synced",
      normalized: result.normalized,
      counts: result.counts,
      detailRequests: result.detailRequests,
      incremental: result.incremental,
      issues: result.issues,
      durationMs: result.durationMs,
      timings,
      syncedAt: result.syncedAt,
      cache: {
        changed: cacheWrite.changed,
        metadata: cacheWrite.metadata,
      },
      worklogImport: result.worklogImport,
      worklogs: {
        metadata: worklogCacheWrite.metadata,
        sizeBytes: worklogCacheWrite.sizeBytes,
      },
      worklogUpload,
    };

    sendProgress({ phase: "complete", message: "Sync Complete" });
    sendCacheEvent(cacheWrite.changed ? "cache-updated" : "cache-unchanged", payload);
    if (respond) sendJson(respond, 200, payload);
    return payload;
  } catch (error) {
    const statusCode =
      error?.status === 401 || error?.status === 403
        ? 401
        : /network|fetch|contact|ENOTFOUND|ECONN/i.test(error?.message || "")
        ? 502
        : 500;
    const payload = {
      error:
        statusCode === 401
          ? "Authentication failed."
          : statusCode === 502
          ? "Unable to contact Elitical."
          : "Elitical import failed.",
      ...safeError(error),
    };

    sendProgress({ phase: "failed", message: payload.message || payload.error });
    sendCacheEvent("sync-failed", payload);
    if (respond) sendJson(respond, statusCode, payload);
    return null;
  } finally {
    syncInProgress = false;
    sendCacheEvent("sync-finished", { syncInProgress: false });
  }
}

function startBackgroundSync() {
  if (backgroundSyncStarted || syncInProgress) return;

  backgroundSyncStarted = true;

  setTimeout(() => {
    runLiveSync().finally(() => {
      backgroundSyncStarted = false;
    });
  }, 250);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "elitical-worklog-local-backend",
      syncInProgress,
      lastProgress,
      cacheExists: await cacheService.exists(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/elitical/sync-live/events") {
    handleProgressStream(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/elitical/sync-live") {
    await runLiveSync({ respond: res });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache/events") {
    handleCacheEvents(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache") {
    const skipBackgroundSync = url.searchParams.get("skipBackgroundSync") === "1";
    const graph = await cacheService.loadGraph();

    if (!graph) {
      sendJson(res, 404, {
        error: "No local cache",
        message: "No local cache is available yet.",
      });
      return;
    }

    const metadata = await cacheService.readMetadata();
    sendJson(res, 200, {
      status: "hit",
      normalized: graph,
      metadata,
    });
    if (!skipBackgroundSync) startBackgroundSync();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache/metadata") {
    const metadata = await cacheService.readMetadata();

    if (!metadata) {
      sendJson(res, 404, {
        error: "No local cache metadata",
      });
      return;
    }

    sendJson(res, 200, {
      status: "hit",
      metadata,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cache/clear") {
    await cacheService.clear();
    await worklogService.clearImportedWorklogs();
    sendCacheEvent("cache-cleared");
    sendJson(res, 200, {
      status: "cleared",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/worklogs") {
    sendJson(res, 200, await worklogService.loadImportedWorklogs());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/worklogs/metadata") {
    sendJson(res, 200, await worklogService.getImportedWorklogMetadata());
    return;
  }

  const worklogMatch = url.pathname.match(/^\/api\/worklogs\/([^/]+)(?:\/([^/]+))?$/);

  if (worklogMatch) {
    const docketId = decodeURIComponent(worklogMatch[1]);
    const action = worklogMatch[2] || "";

    try {
      if (req.method === "GET" && !action) {
        sendJson(res, 200, await worklogService.getWorklogState(docketId));
        return;
      }

      if (req.method === "PUT" && action === "draft") {
        const draft = await worklogService.saveDraft(docketId, await readJsonBody(req));
        sendJson(res, 200, {
          status: "saved",
          draft,
        });
        return;
      }

      if (req.method === "DELETE" && action === "draft") {
        await worklogService.clearDraft(docketId);
        sendJson(res, 200, {
          status: "cleared",
        });
        return;
      }

      if (req.method === "POST" && action === "submit") {
        const result = await worklogService.submitWorklog(docketId, await readJsonBody(req));
        sendJson(res, 202, result);
        return;
      }
    } catch (error) {
      sendJson(res, error?.status || 500, {
        error: error?.message || "Worklog request failed.",
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/worklogs/upload-pending") {
    sendJson(res, 200, await worklogService.uploadPending());
    return;
  }

  sendJson(res, 404, {
    error: "Not Found",
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Local backend ready: http://127.0.0.1:${PORT}`);
});
