import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getStoragePaths } from "./StoragePathService.mjs";
import { applySnapshotToMetadata } from "./SynchronizedSnapshotService.mjs";

const CACHE_VERSION = 1;
const IMPORTER_VERSION = 1;
const GRAPH_VERSION = 1;

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashFor(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function itemHashShape(item) {
  return {
    id: item.id,
    parentId: item.parentId,
    title: item.title,
    type: item.type,
    docketState: item.docketState,
    storyPoints: item.storyPoints || 0,
    sprint: item.sprint || "",
    elitical: {
      projectId: item.elitical?.projectId || "",
      sprintId: item.elitical?.sprintId || "",
      epicId: item.elitical?.epicId || "",
      storyId: item.elitical?.storyId || "",
    },
  };
}

function graphHashShape(graph) {
  return {
    projects: graph.projects || [],
    epics: graph.epics || [],
    stories: graph.stories || [],
    jobs: graph.jobs || [],
    tasks: graph.tasks || [],
    appState: {
      sprints: graph.appState?.sprints || [],
      workItems: (graph.appState?.workItems || []).map(itemHashShape),
    },
  };
}

function metadataFor(graph, syncedAt, syncIndex = null, previousMetadata = null) {
  const workItems = graph.appState?.workItems || [];
  const projects = graph.projects || [];
  const stories = graph.stories || [];
  const jobs = graph.jobs || [];
  const tasks = graph.tasks || [];
  const remoteIndex = syncIndex || (
    previousMetadata?.dockets && Object.keys(previousMetadata.dockets).length
      ? previousMetadata
      : null
  );

  return applySnapshotToMetadata({
    lastSyncTime: syncedAt || new Date().toISOString(),
    eliticalProjectId: projects[0]?.id || "",
    cacheVersion: CACHE_VERSION,
    importerVersion: IMPORTER_VERSION,
    graphVersion: GRAPH_VERSION,
    nodeCount: workItems.length,
    storyCount: stories.length,
    jobCount: jobs.length,
    taskCount: tasks.length,
    hash: hashFor(graphHashShape(graph)),
    lastSuccessfulSync:
      remoteIndex?.lastSuccessfulSync ||
      previousMetadata?.lastSuccessfulSync ||
      syncedAt ||
      new Date().toISOString(),
    projectId:
      remoteIndex?.projectId ||
      previousMetadata?.projectId ||
      previousMetadata?.eliticalProjectId ||
      projects[0]?.id ||
      "",
    dockets: remoteIndex?.dockets || {},
  }, graph?.snapshot || {});
}

export class CacheService {
  constructor({ cacheDir = process.env.ELITICAL_CACHE_DIR || getStoragePaths().dataDir } = {}) {
    this.cacheDir = cacheDir;
    this.graphPath = path.join(cacheDir, "graph.json");
    this.layoutPath = path.join(cacheDir, "layout.json");
    this.settingsPath = path.join(cacheDir, "settings.json");
    this.metadataPath = path.join(cacheDir, "metadata.json");
  }

  async ensureCacheDir() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async writeJsonAtomic(filePath, payload) {
    await this.ensureCacheDir();

    const tmpPath = `${filePath}.tmp`;
    const json = `${JSON.stringify(payload, null, 2)}\n`;

    await fs.writeFile(tmpPath, json, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  async readJson(filePath) {
    const raw = await fs.readFile(filePath, "utf8");

    return JSON.parse(raw);
  }

  async exists() {
    try {
      await fs.access(this.graphPath);
      return true;
    } catch {
      return false;
    }
  }

  async loadGraph() {
    if (!(await this.exists())) return null;

    return this.readJson(this.graphPath);
  }

  async readMetadata() {
    try {
      return await this.readJson(this.metadataPath);
    } catch {
      return null;
    }
  }

  async updateMetadata(updates = {}) {
    const current = (await this.readMetadata()) || {};
    const next = {
      ...current,
      ...updates,
    };

    await this.writeJsonAtomic(this.metadataPath, next);

    return next;
  }

  async saveGraph(graph, { syncedAt, syncIndex } = {}) {
    const previousMetadata = await this.readMetadata();
    const metadata = metadataFor(graph, syncedAt, syncIndex, previousMetadata);
    const changed = previousMetadata?.hash !== metadata.hash;

    await this.writeJsonAtomic(this.graphPath, graph);
    await this.writeJsonAtomic(this.metadataPath, metadata);
    await this.ensureSupportFiles();

    return {
      metadata,
      graph,
      changed,
      previousHash: previousMetadata?.hash || "",
    };
  }

  async ensureSupportFiles() {
    await this.ensureCacheDir();

    await Promise.all([
      fs.access(this.layoutPath).catch(() => this.writeJsonAtomic(this.layoutPath, {})),
      fs.access(this.settingsPath).catch(() => this.writeJsonAtomic(this.settingsPath, {})),
    ]);
  }

  async clear() {
    await Promise.all([
      fs.rm(this.graphPath, { force: true }),
      fs.rm(this.layoutPath, { force: true }),
      fs.rm(this.settingsPath, { force: true }),
      fs.rm(this.metadataPath, { force: true }),
    ]);
  }
}
