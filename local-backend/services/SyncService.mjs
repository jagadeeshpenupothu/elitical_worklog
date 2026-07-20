import { publishCacheFiles } from "./GitHubDataService.mjs";
import { loadEnvFile } from "node:process";

function safeError(error) {
  return {
    message: error?.message || "Local backend error",
    status: error?.status || 0,
    endpoint: error?.endpoint || "",
    name: error?.name || "",
    code: error?.code || "",
    stack: error?.stack || "",
    cause: serializeCause(error?.cause),
  };
}

function serializeCause(cause) {
  if (!cause) return null;

  if (cause instanceof Error) {
    return {
      name: cause.name || "",
      message: cause.message || "",
      stack: cause.stack || "",
      cause: serializeCause(cause.cause),
    };
  }

  if (typeof cause === "object") {
    return cause;
  }

  return String(cause);
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

export class SyncService {
  constructor({ localData, events, publishEnabled = true } = {}) {
    this.localData = localData;
    this.events = events;
    this.publishEnabled = publishEnabled;
    this.providers = new Map();
    this.syncInProgress = false;
    this.backgroundSyncStarted = false;
    this.scheduleHandle = null;
  }

  registerProvider(provider) {
    this.providers.set(provider.id, provider);
  }

  status() {
    return {
      syncInProgress: this.syncInProgress,
      lastProgress: this.events.lastProgress,
      providers: Array.from(this.providers.keys()),
    };
  }

  provider(id = "elitical") {
    const provider = this.providers.get(id);

    if (!provider) {
      const error = new Error(`Sync provider is not registered: ${id}`);
      error.statusCode = 400;
      throw error;
    }

    return provider;
  }

  async publishSnapshot({ graph, worklogs, metadata, message } = {}) {
    if (!this.publishEnabled) {
      return {
        status: "skipped",
        message: "GitHub publication is disabled.",
      };
    }

    this.events.cache("github-publish-started", {
      message: "Publishing latest cache to GitHub...",
    });
    this.events.progress({
      direction: "inbound",
      state: "running",
      phase: "publishing",
      message: "Publishing synchronized snapshot for Web...",
    });

    try {
      const publishResult = await publishCacheFiles({
          graph,
          worklogs,
          metadata,
          message: message || `data: publish Elitical cache ${new Date().toISOString()}`,
        });

      this.events.cache("github-publish-complete", {
        message: "Published latest cache to GitHub.",
        publish: publishResult,
      });
      this.events.progress({
        direction: "inbound",
        state: "running",
        phase: "published",
        message: "Published synchronized snapshot for Web.",
      });

      return {
        ...publishResult,
        status: "published",
      };
    } catch (error) {
      const payload = {
        status: "publication-failed",
        warning: "GitHub publish failed.",
        message:
          error?.message ||
          "Elitical sync completed locally, but the latest cache could not be published to GitHub.",
        statusCode: error?.statusCode || error?.status || 0,
        snapshotId: metadata?.syncGenerationId || metadata?.snapshotId || "",
      };

      console.warn("[local-backend] GitHub cache publish failed", payload);
      this.events.progress({
        direction: "inbound",
        state: "running",
        phase: "publication-failed",
        message: payload.message,
      });
      this.events.cache("github-publish-failed", payload);

      return payload;
    }
  }

  async publishLatestLocalSnapshot() {
    const snapshot = await this.localData.loadFinalizedSnapshot();

    if (!snapshot?.graph || !snapshot?.worklogs || !snapshot?.metadata) {
      const error = new Error("No finalized local snapshot is available to publish.");
      error.statusCode = 404;
      throw error;
    }

    return this.publishSnapshot({
      ...snapshot,
      message: `data: publish latest local Elitical snapshot ${new Date().toISOString()}`,
    });
  }

  convergedStatusForPublication(publication) {
    return publication?.status === "published" || publication?.status === "skipped"
      ? "synced"
      : "local-synced-publication-failed";
  }

  messageForPublication(publication) {
    if (publication?.status === "skipped") return "Synced from Elitical.";

    return publication?.status === "published"
      ? "Synced from Elitical and published for Web."
      : "Local sync complete — Web publication failed.";
  }

  async run({ providerId = "elitical" } = {}) {
    if (this.syncInProgress) {
      const error = new Error("Please wait for the current sync to finish.");
      error.statusCode = 409;
      error.payload = {
        error: "Elitical sync is already running.",
        message: error.message,
      };
      throw error;
    }

    const provider = this.provider(providerId);

    this.syncInProgress = true;
    this.events.progress({
      direction: "inbound",
      state: "running",
      phase: "starting",
      message: "Starting Elitical sync...",
    });
    this.events.cache("sync-started", { syncInProgress: true, provider: provider.id });

    try {
      const syncStartedAt = Date.now();
      const context = await this.localData.getSyncContext();
      const result = await provider.import({
        ...context,
        onProgress: (progress) => this.events.progress(progress),
      });
      const cacheWriteStartedAt = Date.now();
      this.events.progress({
        direction: "inbound",
        state: "running",
        phase: "saving-cache",
        message: "Saving local cache...",
      });
      const { cacheWrite, worklogCacheWrite } = await this.localData.saveImportedData({
        graph: result.normalized,
        worklogs: result.worklogs,
        syncedAt: result.syncedAt,
        syncIndex: result.syncIndex,
      });
      const cacheWriteMs = Date.now() - cacheWriteStartedAt;
      const timings = {
        ...result.timings,
        cacheWriteMs,
        totalMs: Date.now() - syncStartedAt,
      };

      printTimingSummary(timings);

      const worklogUpload = await this.localData.uploadPendingWorklogs();

      const publication = await this.publishSnapshot({
        graph: cacheWrite.graph,
        worklogs: worklogCacheWrite.payload,
        metadata: cacheWrite.metadata,
      });

      const payload = {
        status: this.convergedStatusForPublication(publication),
        message: this.messageForPublication(publication),
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
        publication,
        snapshot: {
          id: cacheWrite.metadata?.syncGenerationId || cacheWrite.metadata?.snapshotId || "",
          metadata: cacheWrite.metadata?.snapshot || null,
        },
        worklogImport: result.worklogImport,
        worklogs: {
          metadata: worklogCacheWrite.metadata,
          sizeBytes: worklogCacheWrite.sizeBytes,
        },
        worklogUpload,
      };

      this.events.progress({
        direction: "inbound",
        state: publication?.status === "published" ? "synced" : "failed",
        phase: publication?.status === "published" ? "complete" : "publication-failed",
        message: payload.message,
      });
      this.events.cache(
        publication?.status === "published"
          ? cacheWrite.changed
            ? "cache-updated"
            : "cache-unchanged"
          : "sync-failed",
        payload
      );

      return payload;
    } catch (error) {
      console.error("[SyncService] run() failed", {
        providerId,
        name: error?.name || "",
        code: error?.code || "",
        message: error?.message || String(error),
        status: error?.status || 0,
        statusCode: error?.statusCode || 0,
        endpoint: error?.endpoint || "",
        payload: error?.payload || null,
        stack: error?.stack || "",
        cause: serializeCause(error?.cause),
      });

      const statusCode =
        error?.status === 401 || error?.status === 403
          ? 401
          : /network|fetch|contact|ENOTFOUND|ECONN/i.test(error?.message || "")
          ? 502
          : error?.statusCode || 500;
      const payload = {
        ...(error?.payload || {}),
        error:
          error?.payload?.error ||
          (statusCode === 401
            ? "Authentication failed."
            : statusCode === 502
            ? "Unable to contact Elitical."
            : "Elitical import failed."),
        ...safeError(error),
      };

      this.events.progress({
        direction: "inbound",
        state: "failed",
        phase: "failed",
        message: payload.message || payload.error,
      });
      this.events.cache("sync-failed", payload);

      error.statusCode = statusCode;
      error.payload = payload;
      throw error;
    } finally {
      this.syncInProgress = false;
      this.events.cache("sync-finished", { syncInProgress: false, provider: provider.id });
    }
  }

  startBackground({ providerId = "elitical" } = {}) {
    if (this.backgroundSyncStarted || this.syncInProgress) return;

    this.backgroundSyncStarted = true;

    setTimeout(() => {
      this.run({ providerId })
        .catch(() => {})
        .finally(() => {
          this.backgroundSyncStarted = false;
        });
    }, 250);
  }

  startSchedule({ providerId = "elitical", intervalMs } = {}) {
    this.stopSchedule();

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;

    this.scheduleHandle = setInterval(() => {
      this.startBackground({ providerId });
    }, intervalMs);

    return {
      provider: providerId,
      intervalMs,
    };
  }

  stopSchedule() {
    if (!this.scheduleHandle) return;

    clearInterval(this.scheduleHandle);
    this.scheduleHandle = null;
  }

  async closeProviders() {
    await Promise.all(
      Array.from(this.providers.values()).map(async (provider) => {
        await provider?.close?.();
      })
    );
  }
}

export function createEliticalSyncProvider() {
  let envLoaded = false;
  let sdkProviderPromise = null;
  let sdkProviderLeaseCount = 0;

  function loadEliticalEnv() {
    if (envLoaded) return;

    envLoaded = true;

    try {
      loadEnvFile(process.env.ELITICAL_ENV_PATH || ".env");
    } catch {
      // Environment files are optional in packaged desktop builds.
    }
  }

  async function sdkProvider() {
    loadEliticalEnv();

    if (!sdkProviderPromise) {
      sdkProviderPromise = (async () => {
        const [
          { EliticalAuthService },
          { EliticalClient },
          { EliticalProvider },
        ] = await Promise.all([
          import("../../src/services/elitical/auth/index.js"),
          import("../../src/services/elitical/client/index.js"),
          import("../../src/services/elitical/provider/index.js"),
        ]);
        const authService = new EliticalAuthService({
          baseUrl: process.env.ELITICAL_BASE_URL || undefined,
          dataDir: process.env.ELITICAL_DATA_DIR || undefined,
          storageStatePath: process.env.ELITICAL_STORAGE_STATE_PATH || undefined,
        });

        await authService.initialize();

        const session = await authService.restoreSession();

        if (!session) {
          await authService.login();
        }

        return new EliticalProvider(new EliticalClient(authService));
      })().catch((error) => {
        sdkProviderPromise = null;
        throw error;
      });
    }

    return sdkProviderPromise;
  }

  async function closeSdkProvider({ force = false } = {}) {
    if (!force && sdkProviderLeaseCount > 0) return;

    const providerPromise = sdkProviderPromise;
    sdkProviderPromise = null;

    if (!providerPromise) return;

    try {
      const provider = await providerPromise;
      await provider?.close?.();
    } catch (error) {
      console.warn("[SyncService] SDK provider cleanup failed", {
        message: error?.message || String(error),
      });
    }
  }

  async function acquireSdkProvider() {
    sdkProviderLeaseCount += 1;
    let released = false;

    const release = async () => {
      if (released) return;
      released = true;
      sdkProviderLeaseCount = Math.max(0, sdkProviderLeaseCount - 1);
      await closeSdkProvider();
    };

    try {
      const provider = await sdkProvider();

      return {
        provider,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function withSdkProvider(operation) {
    const sdkLease = await acquireSdkProvider();

    try {
      return await operation(sdkLease.provider);
    } finally {
      await sdkLease.release();
    }
  }

  return {
    id: "elitical",
    name: "Elitical",
    async import({ previousGraph, syncIndex, cachedWorklogs, onProgress } = {}) {
      const { importEliticalLiveToNormalized } = await import(
        "../../src/services/elitical/syncLive.ts"
      );

      return importEliticalLiveToNormalized({
        writeOutput: false,
        onProgress,
        previousGraph,
        syncIndex,
        cachedWorklogs,
      });
    },
    async lookups(projectId) {
      return withSdkProvider(async (provider) => {
        const [
          users,
          states,
          priorities,
          categories,
          sprints,
        ] = await Promise.all([
          provider.getUsers(projectId),
          provider.getStates(projectId),
          provider.getPriorities(),
          provider.getCategories(),
          provider.getSprints(projectId),
        ]);

        return {
          users,
          states,
          priorities,
          categories,
          sprints,
        };
      });
    },
    async updateDocket(docketId, updates) {
      return withSdkProvider((provider) => provider.updateDocket(docketId, updates));
    },
    async close() {
      await closeSdkProvider({ force: true });
    },
  };
}
