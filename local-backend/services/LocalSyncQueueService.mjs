import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const QUEUE_VERSION = 1;
const MUTATION_ACTIONABLE_STATUSES = new Set(["pending-create", "pending-update"]);
const COMPLETED_STATUSES = new Set(["synced", "completed"]);
const LOCAL_DOCKET_PREFIX = "local-docket-";
const LOCAL_WORKLOG_PREFIX = "local-worklog-";
const ACTIONABILITY = {
  MUTATION_ACTIONABLE: "mutation-actionable",
  RECONCILIATION_ACTIONABLE: "reconciliation-actionable",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  DEPENDENCY_BLOCKED: "dependency-blocked",
};

function nowIso() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
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

function remoteIdForItem(item) {
  return firstString(item?.sync?.remoteId, item?.remoteId, item?.elitical?.remoteId, item?.id);
}

function normalizedText(value) {
  return firstString(value);
}

function normalizedNumber(value) {
  if (value === undefined || value === null || value === "") return 0;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object || {}, field);
}

function baselineForItem(item) {
  const baseline = item?.sync?.remoteBaseline || {};
  const elitical = item?.elitical || {};

  return {
    ...baseline,
    title: normalizedText(baseline.title ?? item?.title),
    description: normalizedText(
      baseline.description ??
      item?.description ??
      item?.descr
    ),
    dktStateId: normalizedText(baseline.dktStateId ?? baseline.stateId ?? elitical.stateId ?? item?.dktStateId),
    dktStateName: normalizedText(baseline.dktStateName ?? baseline.docketState ?? item?.dktStateName ?? item?.docketState),
    assigneeId: normalizedText(baseline.assigneeId ?? elitical.assigneeId ?? item?.assigneeId),
    sprintId: normalizedText(baseline.sprintId ?? elitical.sprintId ?? item?.sprintId),
    sprintName: normalizedText(baseline.sprintName ?? item?.sprintName ?? item?.sprint),
    category: normalizedText(baseline.category ?? item?.category),
    priority: normalizedText(baseline.priority ?? item?.priority),
    epicId: normalizedText(baseline.epicId ?? item?.epicId ?? item?.parentId),
    storyPointEst: normalizedNumber(baseline.storyPointEst ?? item?.storyPointEst ?? item?.storyPoints),
  };
}

function worklogBaselineForItem(worklog = {}) {
  const baseline = worklog.sync?.remoteBaseline || {};

  return {
    ...baseline,
    comment: normalizedText(baseline.comment ?? worklog.comment ?? worklog.description),
    worklogDate: normalizedText(baseline.worklogDate ?? worklog.worklogDate ?? worklog.date),
    hour: normalizedNumber(baseline.hour ?? worklog.hour),
    min: normalizedNumber(baseline.min ?? worklog.min),
  };
}

function worklogChangesAgainstBaseline(changes = {}, baseline = {}) {
  const next = {};

  if (hasOwn(changes, "comment") && normalizedText(changes.comment) !== normalizedText(baseline.comment)) {
    next.comment = normalizedText(changes.comment);
  }
  if (
    (hasOwn(changes, "worklogDate") || hasOwn(changes, "date")) &&
    normalizedText(changes.worklogDate ?? changes.date) !== normalizedText(baseline.worklogDate)
  ) {
    next.worklogDate = normalizedText(changes.worklogDate ?? changes.date);
  }
  if (hasOwn(changes, "hour") && normalizedNumber(changes.hour) !== normalizedNumber(baseline.hour)) {
    next.hour = normalizedNumber(changes.hour);
  }
  if (hasOwn(changes, "min") && normalizedNumber(changes.min) !== normalizedNumber(baseline.min)) {
    next.min = normalizedNumber(changes.min);
  }

  return next;
}

function touchedWorklogFields(changes = {}) {
  const fields = new Set();

  if (hasOwn(changes, "comment")) fields.add("comment");
  if (hasOwn(changes, "worklogDate") || hasOwn(changes, "date")) fields.add("worklogDate");
  if (hasOwn(changes, "hour")) fields.add("hour");
  if (hasOwn(changes, "min")) fields.add("min");

  return fields;
}

function changesAgainstBaseline(changes = {}, baseline = {}) {
  const next = {};

  if (
    hasOwn(changes, "title") &&
    normalizedText(changes.title) !== normalizedText(baseline.title)
  ) {
    next.title = normalizedText(changes.title);
  }

  if (
    hasOwn(changes, "description") &&
    normalizedText(changes.description) !== normalizedText(baseline.description)
  ) {
    next.description = normalizedText(changes.description);
  }

  if (
    hasOwn(changes, "descr") &&
    !hasOwn(next, "description") &&
    normalizedText(changes.descr) !== normalizedText(baseline.description)
  ) {
    next.description = normalizedText(changes.descr);
  }

  [
    "dktStateId",
    "dktStateName",
    "assigneeId",
    "sprintId",
    "sprintName",
    "category",
    "priority",
    "epicId",
  ].forEach((field) => {
    if (hasOwn(changes, field) && normalizedText(changes[field]) !== normalizedText(baseline[field])) {
      next[field] = normalizedText(changes[field]);
    }
  });

  if (hasOwn(changes, "hasNoSprint")) {
    next.hasNoSprint = Boolean(changes.hasNoSprint);
  }

  if (
    hasOwn(changes, "storyPointEst") &&
    normalizedNumber(changes.storyPointEst) !== normalizedNumber(baseline.storyPointEst)
  ) {
    next.storyPointEst = normalizedNumber(changes.storyPointEst);
  } else if (
    hasOwn(changes, "storyPoints") &&
    normalizedNumber(changes.storyPoints) !== normalizedNumber(baseline.storyPointEst)
  ) {
    next.storyPointEst = normalizedNumber(changes.storyPoints);
  }

  return next;
}

function touchedSupportedFields(changes = {}) {
  const fields = new Set();

  if (hasOwn(changes, "title")) fields.add("title");
  if (
    hasOwn(changes, "description") ||
    hasOwn(changes, "descr")
  ) {
    fields.add("description");
  }
  [
    "dktStateId",
    "dktStateName",
    "assigneeId",
    "sprintId",
    "sprintName",
    "hasNoSprint",
    "category",
    "priority",
    "epicId",
    "storyPointEst",
  ].forEach((field) => {
    if (hasOwn(changes, field)) fields.add(field);
  });
  if (hasOwn(changes, "storyPoints")) fields.add("storyPointEst");

  return fields;
}

function isAcceptedButUnconfirmed(operation = {}) {
  return (
    operation.status === "sync-unconfirmed" ||
    (operation.acceptedMutation === true && operation.retryMutation === false) ||
    operation.ambiguousMutation === true ||
    (
      operation.operation === "create" &&
      operation.status === "sync-failed" &&
      isAmbiguousQueueError(operation.lastError)
    )
  );
}

function isAmbiguousQueueError(value) {
  const text = String(value || "").toLowerCase();

  return (
    text.includes("aborterror") ||
    text.includes("signal is aborted") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("target page, context or browser has been closed") ||
    text.includes("page closed") ||
    text.includes("context closed") ||
    text.includes("browser closed") ||
    text.includes("networkerror") ||
    text.includes("network error") ||
    text.includes("socket hang up") ||
    text.includes("econnreset") ||
    text.includes("response lost")
  );
}

function hasUnresolvedDependency(operation = {}, queue = {}) {
  const dependencyId = firstString(operation.dependsOn);

  if (!dependencyId) return false;
  if (queue.localToRemote?.[dependencyId]) return false;

  return dependencyId.startsWith(LOCAL_DOCKET_PREFIX);
}

function blockedClassification(reason = "blocked") {
  return {
    actionability: reason === "dependency" ? ACTIONABILITY.DEPENDENCY_BLOCKED : ACTIONABILITY.BLOCKED,
    actionable: false,
    mutationActionable: false,
    reconciliationActionable: false,
    retryable: false,
    completed: false,
    blocked: true,
    dependencyBlocked: reason === "dependency",
  };
}

function classifyOperation(operation = {}, queue = {}) {
  if (COMPLETED_STATUSES.has(operation.status)) {
    return {
      actionability: ACTIONABILITY.COMPLETED,
      actionable: false,
      mutationActionable: false,
      reconciliationActionable: false,
      retryable: false,
      completed: true,
      blocked: false,
      dependencyBlocked: false,
    };
  }

  if (hasUnresolvedDependency(operation, queue)) {
    return blockedClassification("dependency");
  }

  if (isAcceptedButUnconfirmed(operation)) {
    return {
      actionability: ACTIONABILITY.RECONCILIATION_ACTIONABLE,
      actionable: true,
      mutationActionable: false,
      reconciliationActionable: true,
      retryable: false,
      completed: false,
      blocked: false,
      dependencyBlocked: false,
    };
  }

  if (
    MUTATION_ACTIONABLE_STATUSES.has(operation.status) ||
    operation.status === "dependency-blocked"
  ) {
    return {
      actionability: ACTIONABILITY.MUTATION_ACTIONABLE,
      actionable: true,
      mutationActionable: true,
      reconciliationActionable: false,
      retryable: true,
      completed: false,
      blocked: false,
      dependencyBlocked: false,
    };
  }

  if (operation.status === "sync-failed" && operation.retryMutation !== false) {
    return {
      actionability: ACTIONABILITY.MUTATION_ACTIONABLE,
      actionable: true,
      mutationActionable: true,
      reconciliationActionable: false,
      retryable: true,
      completed: false,
      blocked: false,
      dependencyBlocked: false,
    };
  }

  return blockedClassification();
}

function classifiedOperations(queue) {
  return (queue.operations || []).map((operation) => ({
    ...operation,
    classification: classifyOperation(operation, queue),
  }));
}

function isMutationActionable(operation) {
  return classifyOperation(operation).mutationActionable;
}

function actionableOperations(queue) {
  return classifiedOperations(queue)
    .filter((operation) => operation.classification.actionable)
    .map(({ classification: _classification, ...operation }) => operation);
}

function processableOperations(queue) {
  return classifiedOperations(queue)
    .filter((operation) =>
      operation.classification.actionable || operation.classification.dependencyBlocked
    )
    .map(({ classification: _classification, ...operation }) => operation);
}

function itemCollections(graph) {
  return ["epics", "stories", "jobs", "tasks"].map((key) => [
    key,
    Array.isArray(graph?.[key]) ? graph[key] : [],
  ]);
}

function replaceItemIdInGraph(graph, localId, remoteId) {
  const rewriteWorklog = (worklog) => {
    if (!worklog || typeof worklog !== "object") return worklog;

    const next = {
      ...worklog,
      docketId: worklog.docketId === localId ? remoteId : worklog.docketId,
    };

    if (next.sync?.pendingChanges?.docketId === localId) {
      next.sync = {
        ...next.sync,
        pendingChanges: {
          ...(next.sync.pendingChanges || {}),
          docketId: remoteId,
        },
      };
    }

    return next;
  };
  const rewrite = (item) => {
    if (!item || typeof item !== "object") return item;

    const next = {
      ...item,
      id: item.id === localId ? remoteId : item.id,
      parentId: item.parentId === localId ? remoteId : item.parentId,
      sourceId: item.sourceId === localId ? remoteId : item.sourceId,
      epicId: item.epicId === localId ? remoteId : item.epicId,
      storyId: item.storyId === localId ? remoteId : item.storyId,
      sync: {
        ...(item.sync || {}),
        status: item.id === localId ? "synced" : item.sync?.status || "synced",
        remoteId: item.id === localId ? remoteId : item.sync?.remoteId || remoteIdForItem(item),
        localId: item.id === localId ? localId : item.sync?.localId,
        lastSyncedAt: item.id === localId ? nowIso() : item.sync?.lastSyncedAt,
      },
    };

    if (Array.isArray(next.worklogs)) {
      next.worklogs = next.worklogs.map(rewriteWorklog);
    }

    if (next.elitical) {
      next.elitical = {
        ...next.elitical,
        epicId: next.elitical.epicId === localId ? remoteId : next.elitical.epicId,
        storyId: next.elitical.storyId === localId ? remoteId : next.elitical.storyId,
        remoteId: next.elitical.remoteId || next.sync.remoteId,
      };
    }

    return next;
  };
  const nextGraph = {
    ...graph,
    appState: {
      ...(graph.appState || {}),
      workItems: (graph.appState?.workItems || []).map(rewrite),
    },
  };

  itemCollections(graph).forEach(([key, items]) => {
    nextGraph[key] = items.map(rewrite);
  });

  return nextGraph;
}

function mergePendingIntoItem(item, operation) {
  if (!item || !operation) return item;

  const changes = operation.operation === "create"
    ? operation.payload || {}
    : operation.changes || {};
  const next = {
    ...item,
    ...(["title", "description"].reduce((acc, key) => {
      if (changes[key] !== undefined) acc[key] = changes[key];
      return acc;
    }, {})),
    sync: {
      ...(item.sync || {}),
      status: operation.status,
      remoteId: operation.remoteId || item.sync?.remoteId || "",
      localId: operation.localId || item.sync?.localId || "",
      operationId: operation.operationId,
      lastError: operation.lastError || "",
      pendingChanges: {
        ...(item.sync?.pendingChanges || {}),
        ...changes,
      },
      remoteBaseline: item.sync?.remoteBaseline || operation.remoteBaseline || null,
    },
  };

  if (next.elitical) {
    next.elitical = {
      ...next.elitical,
      remoteId: next.sync.remoteId || next.elitical.remoteId || "",
    };
  }

  return next;
}

function worklogFromOperation(operation, existing = null) {
  const changes = operation.operation === "create"
    ? operation.payload || {}
    : operation.changes || {};
  const id = operation.localId || operation.remoteId || existing?.id || "";
  const next = {
    ...(existing || {}),
    ...changes,
    id,
    docketId: operation.docketId || changes.docketId || existing?.docketId || "",
    comment: changes.comment ?? existing?.comment ?? existing?.description ?? "",
    description: changes.comment ?? existing?.description ?? existing?.comment ?? "",
    worklogDate: changes.worklogDate ?? changes.date ?? existing?.worklogDate ?? existing?.date ?? "",
    date: changes.worklogDate ?? changes.date ?? existing?.date ?? existing?.worklogDate ?? "",
    hour: normalizedNumber(changes.hour ?? existing?.hour),
    min: normalizedNumber(changes.min ?? existing?.min),
    sync: {
      ...(existing?.sync || {}),
      status: operation.status,
      remoteId: operation.remoteId || existing?.sync?.remoteId || existing?.remoteId || "",
      localId: operation.localId || existing?.sync?.localId || "",
      operationId: operation.operationId,
      lastError: operation.lastError || "",
      pendingChanges: {
        ...(existing?.sync?.pendingChanges || {}),
        ...changes,
      },
      remoteBaseline: existing?.sync?.remoteBaseline || operation.remoteBaseline || null,
    },
  };

  next.timeMinutes = normalizedNumber(next.hour) * 60 + normalizedNumber(next.min);

  return next;
}

function mergePendingWorklogsIntoItem(item, operations) {
  if (!item || !operations.length) return item;

  const currentWorklogs = Array.isArray(item.worklogs) ? item.worklogs : [];
  let nextWorklogs = currentWorklogs;

  operations.forEach((operation) => {
    const existing = nextWorklogs.find((entry) =>
      [entry?.id, entry?.worklogId, entry?.sync?.localId, entry?.sync?.remoteId]
        .filter(Boolean)
        .includes(operation.localId) ||
      [entry?.id, entry?.worklogId, entry?.sync?.remoteId]
        .filter(Boolean)
        .includes(operation.remoteId)
    );
    const nextWorklog = worklogFromOperation(operation, existing);

    nextWorklogs = [
      nextWorklog,
      ...nextWorklogs.filter((entry) => entry !== existing),
    ];
  });

  return {
    ...item,
    worklogs: nextWorklogs,
  };
}

export class LocalSyncQueueService {
  constructor({ cacheDir = process.env.ELITICAL_CACHE_DIR || path.resolve("local-backend/cache") } = {}) {
    this.cacheDir = cacheDir;
    this.queuePath = path.join(cacheDir, "sync-queue.json");
  }

  async ensureCacheDir() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  emptyQueue() {
    return {
      version: QUEUE_VERSION,
      operations: [],
      localToRemote: {},
      updatedAt: nowIso(),
    };
  }

  async write(queue) {
    await this.ensureCacheDir();

    const next = {
      version: QUEUE_VERSION,
      operations: Array.isArray(queue?.operations) ? queue.operations : [],
      localToRemote: queue?.localToRemote || {},
      updatedAt: nowIso(),
    };
    const tmpPath = `${this.queuePath}.tmp`;

    await fs.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.queuePath);

    return next;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(raw);

      return {
        ...this.emptyQueue(),
        ...parsed,
        operations: Array.isArray(parsed.operations) ? parsed.operations : [],
        localToRemote: parsed.localToRemote || {},
      };
    } catch {
      return this.emptyQueue();
    }
  }

  async summary() {
    const queue = await this.load();
    const operations = classifiedOperations(queue);
    const mutationActionable = operations.filter((operation) =>
      operation.classification.mutationActionable
    );
    const reconciliationActionable = operations.filter((operation) =>
      operation.classification.reconciliationActionable
    );
    const actionable = operations.filter((operation) =>
      operation.classification.actionable
    );
    const failed = operations.filter((operation) => operation.status === "sync-failed");
    const blocked = operations.filter((operation) => operation.classification.blocked);

    return {
      pendingCount: actionable.length,
      actionableCount: actionable.length,
      mutationActionableCount: mutationActionable.length,
      reconciliationActionableCount: reconciliationActionable.length,
      retryablePendingCount: mutationActionable.length,
      unconfirmedCount: reconciliationActionable.length,
      failedCount: failed.length,
      blockedCount: blocked.length,
      operations,
      updatedAt: queue.updatedAt,
    };
  }

  localDocketId() {
    return `${LOCAL_DOCKET_PREFIX}${id()}`;
  }

  localWorklogId() {
    return `${LOCAL_WORKLOG_PREFIX}${id()}`;
  }

  isLocalId(value) {
    return String(value || "").startsWith(LOCAL_DOCKET_PREFIX);
  }

  isLocalWorklogId(value) {
    return String(value || "").startsWith(LOCAL_WORKLOG_PREFIX);
  }

  classifyOperation(operation = {}) {
    return classifyOperation(operation, { localToRemote: {} });
  }

  async enqueueCreate({ item, payload }) {
    const queue = await this.load();
    const timestamp = nowIso();
    const existing = queue.operations.find(
      (operation) =>
        operation.entityType === "docket" &&
        operation.operation === "create" &&
        operation.localId === item.id &&
        isMutationActionable(operation)
    );

    if (existing) {
      existing.payload = {
        ...(existing.payload || {}),
        ...payload,
        title: item.title,
        description: item.description || "",
      };
      existing.updatedAt = timestamp;
      existing.status = existing.status === "sync-failed" ? "pending-create" : existing.status;
      existing.lastError = "";
    } else {
      queue.operations.push({
        operationId: `queue-${id()}`,
        entityType: "docket",
        operation: "create",
        localId: item.id,
        remoteId: "",
        docketType: normalizeDocketType(item.type),
        payload: {
          ...payload,
          id: item.id,
          type: normalizeDocketType(item.type),
          title: item.title,
          description: item.description || "",
        },
        changes: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "pending-create",
        attempts: 0,
        lastError: "",
      });
    }

    return this.write(queue);
  }

  async enqueueUpdate({ item, changes, baselineItem = null }) {
    const queue = await this.load();
    const timestamp = nowIso();
    const createOperation = queue.operations.find(
      (operation) =>
        operation.entityType === "docket" &&
        operation.operation === "create" &&
        operation.localId === item.id &&
        isMutationActionable(operation)
    );

    if (createOperation) {
      createOperation.payload = {
        ...(createOperation.payload || {}),
        ...changes,
      };
      createOperation.updatedAt = timestamp;
      createOperation.status =
        createOperation.status === "sync-failed" ? "pending-create" : createOperation.status;
      createOperation.lastError = "";
      return this.write(queue);
    }

    const remoteBaseline = item.sync?.remoteBaseline || baselineForItem(baselineItem || item);
    const nextChanges = changesAgainstBaseline(changes, remoteBaseline);
    const remoteId = firstString(item.sync?.remoteId, item.elitical?.remoteId, item.id);
    const existing = queue.operations.find(
      (operation) =>
        operation.entityType === "docket" &&
        operation.operation === "update" &&
        operation.localId === item.id &&
        isMutationActionable(operation)
    );

    if (existing) {
      const touchedFields = touchedSupportedFields(changes);

      existing.changes = {
        ...(existing.changes || {}),
        ...nextChanges,
      };
      touchedFields.forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(nextChanges, field)) {
          delete existing.changes[field];
        }
      });
      existing.remoteId = remoteId;
      existing.remoteBaseline = existing.remoteBaseline || remoteBaseline;
      existing.updatedAt = timestamp;
      existing.status = existing.status === "sync-failed" ? "pending-update" : existing.status;
      existing.lastError = "";
      if (!Object.keys(existing.changes).length) {
        queue.operations = queue.operations.filter(
          (operation) => operation.operationId !== existing.operationId
        );
      }
    } else {
      if (Object.keys(nextChanges).length) {
        queue.operations.push({
          operationId: `queue-${id()}`,
          entityType: "docket",
          operation: "update",
          localId: item.id,
          remoteId,
          docketType: normalizeDocketType(item.type),
          payload: {},
          changes: nextChanges,
          remoteBaseline,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "pending-update",
          attempts: 0,
          lastError: "",
        });
      }
    }

    return this.write(queue);
  }

  async enqueueWorklogCreate({ worklog, dependsOn = "" }) {
    const queue = await this.load();
    const timestamp = nowIso();
    const existing = queue.operations.find(
      (operation) =>
        operation.entityType === "worklog" &&
        operation.operation === "create" &&
        operation.localId === worklog.id &&
        isMutationActionable(operation)
    );

    if (existing) {
      existing.payload = {
        ...(existing.payload || {}),
        ...worklog,
      };
      existing.dependsOn = dependsOn || existing.dependsOn || "";
      existing.updatedAt = timestamp;
      existing.status = existing.status === "sync-failed" ? "pending-create" : existing.status;
      existing.lastError = "";
    } else {
      queue.operations.push({
        operationId: `queue-${id()}`,
        entityType: "worklog",
        operation: "create",
        localId: worklog.id,
        remoteId: "",
        docketId: worklog.docketId,
        dependsOn,
        payload: {
          ...worklog,
        },
        changes: {},
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "pending-create",
        attempts: 0,
        lastError: "",
      });
    }

    return this.write(queue);
  }

  async enqueueWorklogUpdate({ worklog, changes, baselineWorklog = null }) {
    const queue = await this.load();
    const timestamp = nowIso();
    const remoteBaseline = worklog.sync?.remoteBaseline || worklogBaselineForItem(baselineWorklog || worklog);
    const nextChanges = worklogChangesAgainstBaseline(changes, remoteBaseline);
    const remoteId = firstString(worklog.sync?.remoteId, worklog.remoteId, worklog.id);
    const existing = queue.operations.find(
      (operation) =>
        operation.entityType === "worklog" &&
        operation.operation === "update" &&
        operation.localId === worklog.id &&
        isMutationActionable(operation)
    );

    if (existing) {
      const touchedFields = touchedWorklogFields(changes);

      existing.changes = {
        ...(existing.changes || {}),
        ...nextChanges,
      };
      touchedFields.forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(nextChanges, field)) {
          delete existing.changes[field];
        }
      });
      existing.remoteId = remoteId;
      existing.docketId = worklog.docketId;
      existing.remoteBaseline = existing.remoteBaseline || remoteBaseline;
      existing.updatedAt = timestamp;
      existing.status = existing.status === "sync-failed" ? "pending-update" : existing.status;
      existing.lastError = "";
      if (!Object.keys(existing.changes).length) {
        queue.operations = queue.operations.filter(
          (operation) => operation.operationId !== existing.operationId
        );
      }
    } else if (Object.keys(nextChanges).length) {
      queue.operations.push({
        operationId: `queue-${id()}`,
        entityType: "worklog",
        operation: "update",
        localId: worklog.id,
        remoteId,
        docketId: worklog.docketId,
        payload: {},
        changes: nextChanges,
        remoteBaseline,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "pending-update",
        attempts: 0,
        lastError: "",
      });
    }

    return this.write(queue);
  }

  async markOperationFailed(operationId, error) {
    const queue = await this.load();
    const operation = queue.operations.find((entry) => entry.operationId === operationId);

    if (operation) {
      operation.status = "sync-failed";
      operation.attempts = Number(operation.attempts || 0) + 1;
      operation.lastError = error?.message || String(error || "Sync failed.");
      operation.updatedAt = nowIso();
    }

    return this.write(queue);
  }

  async markOperationDependencyBlocked(operationId, error) {
    const queue = await this.load();
    const operation = queue.operations.find((entry) => entry.operationId === operationId);

    if (operation) {
      operation.status = "dependency-blocked";
      operation.retryMutation = false;
      operation.lastError = error?.message || String(error || "Operation is waiting for a dependency.");
      operation.updatedAt = nowIso();
    }

    return this.write(queue);
  }

  async markOperationUnconfirmed(operationId, error) {
    const queue = await this.load();
    const operation = queue.operations.find((entry) => entry.operationId === operationId);

    if (operation) {
      operation.status = "sync-unconfirmed";
      operation.acceptedMutation = true;
      operation.ambiguousMutation = true;
      operation.retryMutation = false;
      operation.attempts = Number(operation.attempts || 0) + 1;
      operation.lastError = error?.message || String(error || "Accepted mutation could not be reconciled.");
      operation.updatedAt = nowIso();
    }

    return this.write(queue);
  }

  async markOperationSynced(operationId, { remoteId, localId } = {}) {
    const queue = await this.load();
    const operation = queue.operations.find((entry) => entry.operationId === operationId);

    if (operation) {
      operation.status = "synced";
      operation.remoteId = remoteId || operation.remoteId || "";
      operation.lastError = "";
      operation.updatedAt = nowIso();
      if (localId && remoteId) queue.localToRemote[localId] = remoteId;
    }

    return this.write(queue);
  }

  async markUpdateFieldsSynced(operationId, { remoteId, localId, acceptedChanges = {}, remoteBaseline = null, error = null } = {}) {
    const queue = await this.load();
    const operation = queue.operations.find((entry) => entry.operationId === operationId);

    if (operation) {
      const remainingChanges = {
        ...(operation.changes || {}),
      };

      Object.keys(acceptedChanges || {}).forEach((field) => {
        delete remainingChanges[field];
      });

      if (acceptedChanges.descr !== undefined) delete remainingChanges.description;
      if (acceptedChanges.description !== undefined) delete remainingChanges.descr;

      operation.changes = remainingChanges;
      operation.remoteId = remoteId || operation.remoteId || "";
      if (remoteBaseline) {
        operation.remoteBaseline = {
          ...(operation.remoteBaseline || {}),
          ...remoteBaseline,
        };
      }
      operation.updatedAt = nowIso();
      if (localId && remoteId) queue.localToRemote[localId] = remoteId;

      if (Object.keys(remainingChanges).length) {
        operation.status = error ? "sync-failed" : "pending-update";
        operation.attempts = Number(operation.attempts || 0) + (error ? 1 : 0);
        operation.lastError = error?.message || "";
      } else {
        operation.status = "synced";
        operation.lastError = "";
      }
    }

    return this.write(queue);
  }

  dependencyDepth(operation, byLocalId) {
    let depth = 0;
    let parentId = operation.payload?.parentId;
    const visited = new Set([operation.localId]);

    while (parentId && byLocalId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byLocalId.get(parentId)?.payload?.parentId;
    }

    return depth;
  }

  orderedPendingOperations(queue) {
    const pending = processableOperations(queue);
    const docketCreates = pending.filter((operation) =>
      operation.entityType === "docket" && operation.operation === "create"
    );
    const worklogCreates = pending.filter((operation) =>
      operation.entityType === "worklog" && operation.operation === "create"
    );
    const byLocalId = new Map(docketCreates.map((operation) => [operation.localId, operation]));
    const docketUpdates = pending.filter((operation) =>
      operation.entityType === "docket" && operation.operation === "update"
    );
    const worklogUpdates = pending.filter((operation) =>
      operation.entityType === "worklog" && operation.operation === "update"
    );

    return [
      ...docketCreates.sort((first, second) =>
        this.dependencyDepth(first, byLocalId) - this.dependencyDepth(second, byLocalId)
      ),
      ...docketUpdates,
      ...worklogCreates,
      ...worklogUpdates,
    ];
  }

  applyPendingToGraph(graph, queue) {
    const pendingByLocalId = new Map(
      actionableOperations(queue)
        .filter((operation) => operation.entityType === "docket")
        .map((operation) => [operation.localId, operation])
    );
    const pendingWorklogsByDocket = new Map();

    actionableOperations(queue)
      .filter((operation) => operation.entityType === "worklog")
      .forEach((operation) => {
        const docketId = operation.docketId || operation.payload?.docketId;
        if (!docketId) return;

        const entries = pendingWorklogsByDocket.get(docketId) || [];
        entries.push(operation);
        pendingWorklogsByDocket.set(docketId, entries);
      });
    const overlay = (item) => mergePendingWorklogsIntoItem(
      mergePendingIntoItem(item, pendingByLocalId.get(item?.id)),
      pendingWorklogsByDocket.get(item?.id) || []
    );
    const nextGraph = {
      ...graph,
      appState: {
        ...(graph.appState || {}),
        workItems: (graph.appState?.workItems || []).map(overlay),
      },
    };

    itemCollections(graph).forEach(([key, items]) => {
      nextGraph[key] = items.map(overlay);
    });

    return nextGraph;
  }

  async applyPendingGraph(graph) {
    return this.applyPendingToGraph(graph, await this.load());
  }

  async replaceLocalId(graph, localId, remoteId) {
    const nextGraph = replaceItemIdInGraph(graph, localId, remoteId);
    const queue = await this.load();

    queue.localToRemote[localId] = remoteId;
    queue.operations.forEach((operation) => {
      if (operation.localId === localId) operation.remoteId = remoteId;
      if (operation.payload?.parentId === localId) operation.payload.parentId = remoteId;
      if (operation.payload?.epicId === localId) operation.payload.epicId = remoteId;
      if (operation.payload?.storyId === localId) operation.payload.storyId = remoteId;
      if (operation.docketId === localId) operation.docketId = remoteId;
      if (operation.dependsOn === localId) operation.dependsOn = "";
      if (operation.payload?.docketId === localId) operation.payload.docketId = remoteId;
    });
    await this.write(queue);

    return nextGraph;
  }
}
