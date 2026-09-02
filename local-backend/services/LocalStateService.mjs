import fs from "node:fs/promises";
import path from "node:path";
import { getStoragePaths } from "./StoragePathService.mjs";

const LOCAL_STATE_VERSION = 1;
const DOCKET_COLLECTION_BY_TYPE = {
  epic: "epics",
  story: "stories",
  task: "tasks",
  job: "jobs",
};

function nowIso() {
  return new Date().toISOString();
}

function firstString(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function normalizeDocketType(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["epic", "story", "task", "job"].includes(normalized)) return normalized;
  if (normalized.includes("epic")) return "epic";
  if (normalized.includes("story")) return "story";
  if (normalized.includes("job")) return "job";
  if (normalized.includes("task")) return "task";

  return "";
}

function dedupeById(items = []) {
  const byId = new Map();

  items.forEach((item) => {
    const id = firstString(item?.id);
    if (!id) return;
    byId.set(id, item);
  });

  return Array.from(byId.values());
}

function upsertById(items = [], item) {
  const id = firstString(item?.id);

  if (!id) return dedupeById(items);

  return dedupeById([
    ...items.filter((entry) => entry?.id !== id),
    item,
  ]);
}

function applyStoredDocketsToGraph(graph, dockets = {}) {
  const stored = Object.values(dockets || {})
    .filter((entry) => entry?.item?.id)
    .map((entry) => ({
      ...entry,
      type: normalizeDocketType(entry.type || entry.item?.type || entry.rawRecord?.type),
    }))
    .filter((entry) => entry.type);

  if (!stored.length) return graph;

  const nextGraph = {
    ...graph,
    appState: {
      ...(graph.appState || {}),
      workItems: dedupeById(graph.appState?.workItems || []),
    },
  };

  stored.forEach((entry) => {
    nextGraph.appState.workItems = upsertById(nextGraph.appState.workItems, entry.item);
  });

  Object.entries(DOCKET_COLLECTION_BY_TYPE).forEach(([type, key]) => {
    let collection = dedupeById(Array.isArray(graph?.[key]) ? graph[key] : []);

    stored
      .filter((entry) => entry.type === type)
      .forEach((entry) => {
        collection = upsertById(collection, entry.rawRecord || entry.item);
      });

    nextGraph[key] = collection;
  });

  return nextGraph;
}

export class LocalStateService {
  constructor({ dataDir = process.env.ELITICAL_DATA_DIR || getStoragePaths().dataDir } = {}) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "local-state.json");
  }

  emptyState() {
    return {
      version: LOCAL_STATE_VERSION,
      dockets: {},
      updatedAt: nowIso(),
    };
  }

  async ensureDataDir() {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  async write(state) {
    await this.ensureDataDir();

    const next = {
      ...this.emptyState(),
      ...state,
      dockets: state?.dockets || {},
      updatedAt: nowIso(),
    };
    const tmpPath = `${this.statePath}.tmp`;

    await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.statePath);

    return next;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        ...this.emptyState(),
        ...parsed,
        dockets: parsed.dockets || {},
      };
    } catch {
      return this.emptyState();
    }
  }

  async upsertDocket({ item, rawRecord = null, type = "" } = {}) {
    const id = firstString(item?.id, rawRecord?.id);
    const docketType = normalizeDocketType(type || item?.type || rawRecord?.type);

    if (!id || !item || !docketType) return this.load();

    const state = await this.load();
    state.dockets[id] = {
      id,
      type: docketType,
      item,
      rawRecord: rawRecord || item,
      updatedAt: nowIso(),
    };

    return this.write(state);
  }

  async removeDocket(id) {
    const docketId = firstString(id);

    if (!docketId) return this.load();

    const state = await this.load();
    delete state.dockets[docketId];

    return this.write(state);
  }

  async clear() {
    await fs.rm(this.statePath, { force: true });
  }

  applyToGraph(graph, state) {
    return applyStoredDocketsToGraph(graph, state?.dockets || {});
  }

  async applyGraph(graph) {
    return this.applyToGraph(graph, await this.load());
  }
}
