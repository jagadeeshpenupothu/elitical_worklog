import fs from "node:fs/promises";
import path from "node:path";

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMinutes(value) {
  const minutes = Number(value);

  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

function normalizeDraft(input = {}) {
  return {
    date: String(input.date || todayDate()),
    durationMinutes: normalizeMinutes(input.durationMinutes),
    description: String(input.description || ""),
    updatedAt: new Date().toISOString(),
  };
}

function metadataForWorklogs(cache = {}) {
  const worklogs = Array.isArray(cache.worklogs) ? cache.worklogs : [];
  const employees = Array.from(
    new Map(
      worklogs
        .filter((worklog) => worklog.employeeId || worklog.employeeName)
        .map((worklog) => [
          worklog.employeeId || worklog.employeeName,
          {
            id: worklog.employeeId || "",
            name: worklog.employeeName || "",
          },
        ])
    ).values()
  );
  const dates = worklogs
    .map((worklog) => worklog.worklogDate)
    .filter(Boolean)
    .sort();

  return {
    totalWorklogs: worklogs.length,
    employees,
    dateRange: {
      earliest: dates[0] || "",
      latest: dates[dates.length - 1] || "",
    },
    lastSync: cache.lastSync || "",
  };
}

export class WorklogService {
  constructor({ cacheDir = process.env.ELITICAL_CACHE_DIR || path.resolve("local-backend/cache") } = {}) {
    this.cacheDir = cacheDir;
    this.draftsPath = path.join(cacheDir, "worklog-drafts.json");
    this.pendingPath = path.join(cacheDir, "pending-worklogs.json");
    this.historyPath = path.join(cacheDir, "worklog-history.json");
    this.importedPath = path.join(cacheDir, "worklogs.json");
  }

  async ensureCacheDir() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async readJson(filePath, fallback) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      return fallback;
    }
  }

  async writeJsonAtomic(filePath, payload) {
    await this.ensureCacheDir();

    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  async getDraft(docketId) {
    const drafts = await this.readJson(this.draftsPath, {});

    return drafts[docketId] || null;
  }

  async saveDraft(docketId, draft) {
    const drafts = await this.readJson(this.draftsPath, {});
    const normalized = normalizeDraft(draft);

    drafts[docketId] = normalized;
    await this.writeJsonAtomic(this.draftsPath, drafts);

    return normalized;
  }

  async clearDraft(docketId) {
    const drafts = await this.readJson(this.draftsPath, {});

    delete drafts[docketId];
    await this.writeJsonAtomic(this.draftsPath, drafts);
  }

  async getPending(docketId) {
    const pending = await this.readJson(this.pendingPath, []);

    return pending.filter((entry) => entry.docketId === docketId);
  }

  async getHistory(docketId) {
    const history = await this.readJson(this.historyPath, {});
    const imported = await this.loadImportedWorklogs();
    const importedHistory = imported.worklogs
      .filter((entry) => entry.docketId === docketId)
      .map((entry) => ({
        id: entry.id,
        docketId: entry.docketId,
        date: entry.worklogDate,
        durationMinutes: entry.durationMinutes,
        description: entry.comment,
        employeeId: entry.employeeId,
        employeeName: entry.employeeName,
        source: "elitical",
      }));

    return [...importedHistory, ...(history[docketId] || [])];
  }

  async loadImportedWorklogs() {
    return this.readJson(this.importedPath, {
      version: 1,
      lastSync: "",
      totalWorklogs: 0,
      worklogs: [],
    });
  }

  async saveImportedWorklogs(cache) {
    const payload = {
      version: cache?.version || 1,
      lastSync: cache?.lastSync || new Date().toISOString(),
      totalWorklogs: Array.isArray(cache?.worklogs)
        ? cache.worklogs.length
        : Number(cache?.totalWorklogs || 0),
      worklogs: Array.isArray(cache?.worklogs) ? cache.worklogs : [],
    };

    await this.writeJsonAtomic(this.importedPath, payload);

    return {
      payload,
      metadata: metadataForWorklogs(payload),
      sizeBytes: Buffer.byteLength(JSON.stringify(payload)),
    };
  }

  async getImportedWorklogMetadata() {
    return metadataForWorklogs(await this.loadImportedWorklogs());
  }

  async clearImportedWorklogs() {
    await fs.rm(this.importedPath, { force: true });
  }

  async getWorklogState(docketId) {
    const [draft, pending, history] = await Promise.all([
      this.getDraft(docketId),
      this.getPending(docketId),
      this.getHistory(docketId),
    ]);

    return {
      draft,
      pending,
      history: [...pending, ...history].sort((first, second) =>
        String(second.date || "").localeCompare(String(first.date || ""))
      ),
    };
  }

  validateSubmission(payload = {}) {
    const durationMinutes = normalizeMinutes(payload.durationMinutes);
    const description = String(payload.description || "").trim();

    if (!durationMinutes) {
      return "Duration is required.";
    }

    if (!description) {
      return "Description is required.";
    }

    return "";
  }

  async submitWorklog(docketId, payload = {}) {
    const validationError = this.validateSubmission(payload);

    if (validationError) {
      const error = new Error(validationError);
      error.status = 400;
      throw error;
    }

    const pending = await this.readJson(this.pendingPath, []);
    const entry = {
      id: newId("pending-worklog"),
      docketId,
      date: String(payload.date || todayDate()),
      durationMinutes: normalizeMinutes(payload.durationMinutes),
      description: String(payload.description || "").trim(),
      status: "pending",
      reason: "Elitical worklog create endpoint has not been reverse engineered.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    pending.push(entry);
    await this.writeJsonAtomic(this.pendingPath, pending);
    await this.clearDraft(docketId);

    return {
      status: "queued",
      entry,
      message: "Pending Upload",
    };
  }

  async uploadPending() {
    return {
      uploaded: 0,
      pending: (await this.readJson(this.pendingPath, [])).length,
      skipped: true,
      reason: "Elitical worklog create endpoint has not been reverse engineered.",
    };
  }
}
