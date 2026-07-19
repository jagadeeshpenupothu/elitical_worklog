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
    const [cacheWrite, worklogCacheWrite] = await Promise.all([
      this.cacheService.saveGraph(graphWithPending, { syncedAt, syncIndex }),
      this.worklogService.saveImportedWorklogs(worklogs),
    ]);

    return {
      cacheWrite,
      worklogCacheWrite,
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
