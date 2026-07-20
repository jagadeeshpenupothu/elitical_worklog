import { buildFinalizedSnapshot } from "./SynchronizedSnapshotService.mjs";

export class LocalDataService {
  constructor({ cacheService, worklogService, syncQueueService } = {}) {
    this.cacheService = cacheService;
    this.worklogService = worklogService;
    this.syncQueueService = syncQueueService;
  }

  async exists() {
    return this.cacheService.exists();
  }

  async loadGraphCache() {
    const graph = await this.cacheService.loadGraph();

    if (!graph) return null;

    const queue = this.syncQueueService ? await this.syncQueueService.load() : null;
    const normalized = queue
      ? this.syncQueueService.applyPendingToGraph(graph, queue)
      : graph;

    return {
      status: "hit",
      normalized,
      metadata: await this.cacheService.readMetadata(),
      syncQueue: queue ? await this.syncQueueService.summary() : undefined,
    };
  }

  async loadMetadata() {
    return this.cacheService.readMetadata();
  }

  async getSyncContext() {
    const [previousGraph, previousMetadata, cachedWorklogs] = await Promise.all([
      this.cacheService.loadGraph(),
      this.cacheService.readMetadata(),
      this.worklogService.loadImportedWorklogs(),
    ]);

    return {
      previousGraph,
      previousMetadata,
      cachedWorklogs,
      syncIndex: previousMetadata
        ? {
            lastSuccessfulSync: previousMetadata.lastSuccessfulSync,
            projectId: previousMetadata.projectId || previousMetadata.eliticalProjectId,
            dockets: previousMetadata.dockets || {},
          }
        : null,
    };
  }

  async saveImportedData({ graph, worklogs, syncedAt, syncIndex } = {}) {
    const graphWithPending = this.syncQueueService
      ? await this.syncQueueService.applyPendingGraph(graph)
      : graph;
    const finalized = buildFinalizedSnapshot({
      graph: graphWithPending,
      worklogs,
      metadata: await this.cacheService.readMetadata(),
      syncedAt,
    });
    const [cacheWrite, worklogCacheWrite] = await Promise.all([
      this.cacheService.saveGraph(finalized.graph, { syncedAt, syncIndex }),
      this.worklogService.saveImportedWorklogs(finalized.worklogs),
    ]);

    return {
      cacheWrite,
      worklogCacheWrite,
      snapshot: finalized.snapshot,
      graph: finalized.graph,
      worklogs: worklogCacheWrite.payload,
    };
  }

  async loadFinalizedSnapshot() {
    const [graph, worklogs, metadata] = await Promise.all([
      this.cacheService.loadGraph(),
      this.worklogService.loadImportedWorklogs(),
      this.cacheService.readMetadata(),
    ]);

    if (!graph || !metadata) return null;

    return {
      graph,
      worklogs,
      metadata,
    };
  }

  async updateMetadata(updates = {}) {
    return this.cacheService.updateMetadata(updates);
  }

  async loadWorklogs() {
    return this.worklogService.loadImportedWorklogs();
  }

  async loadWorklogMetadata() {
    return this.worklogService.getImportedWorklogMetadata();
  }

  async getWorklogState(docketId) {
    return this.worklogService.getWorklogState(docketId);
  }

  async saveWorklogDraft(docketId, draft) {
    return this.worklogService.saveDraft(docketId, draft);
  }

  async clearWorklogDraft(docketId) {
    return this.worklogService.clearDraft(docketId);
  }

  async submitWorklog(docketId, payload) {
    return this.worklogService.submitWorklog(docketId, payload);
  }

  async uploadPendingWorklogs() {
    return this.worklogService.uploadPending();
  }

  async clear() {
    await this.cacheService.clear();
    await this.worklogService.clearImportedWorklogs();
  }
}
