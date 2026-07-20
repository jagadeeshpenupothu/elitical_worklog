import crypto from "node:crypto";

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

function sha256(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function firstString(...values) {
  const match = values.find(
    (value) => value !== undefined && value !== null && String(value).trim()
  );

  return match === undefined ? "" : String(match).trim();
}

function worklogMinutes(worklog = {}) {
  const explicitMinutes = Number(worklog.timeMinutes ?? worklog.durationMinutes);

  if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) {
    return Math.round(explicitMinutes);
  }

  const hours = Number(worklog.hour ?? worklog.hours ?? 0);
  const minutes = Number(worklog.min ?? worklog.minutes ?? 0);
  const total = (Number.isFinite(hours) ? hours : 0) * 60 +
    (Number.isFinite(minutes) ? minutes : 0);

  return total > 0 ? Math.round(total) : 0;
}

export function defaultEmployeeFromWorklogs(worklogs = []) {
  const totals = new Map();
  const names = new Map();

  worklogs.forEach((worklog) => {
    const employeeId = firstString(worklog?.employeeId, worklog?.empId);

    if (!employeeId) return;

    totals.set(employeeId, (totals.get(employeeId) || 0) + worklogMinutes(worklog));
    if (!names.has(employeeId)) {
      names.set(employeeId, firstString(worklog?.employeeName, worklog?.employee?.name));
    }
  });

  const [employeeId] =
    Array.from(totals.entries()).sort((first, second) => second[1] - first[1])[0] || [];

  if (!employeeId) return null;

  return {
    id: employeeId,
    employeeId,
    name: names.get(employeeId) || employeeId,
    source: "synchronized-worklogs",
  };
}

export function normalizedWorklogArray(worklogCache = {}) {
  return Array.isArray(worklogCache?.worklogs) ? worklogCache.worklogs : [];
}

export function buildSnapshotDescriptor({
  graph,
  worklogs,
  metadata = {},
  syncedAt,
  createdAt = new Date().toISOString(),
} = {}) {
  const worklogEntries = normalizedWorklogArray(worklogs);
  const effectiveSyncedAt = firstString(syncedAt, metadata?.lastSuccessfulSync, createdAt);
  const graphHash = sha256(graph || {});
  const worklogsHash = sha256(worklogs || {});
  const syncGenerationSequence = Date.parse(effectiveSyncedAt) || Date.parse(createdAt) || Date.now();
  const snapshotHash = sha256({
    graphHash,
    worklogsHash,
    syncedAt: effectiveSyncedAt,
    nodeCount: graph?.appState?.workItems?.length || 0,
    worklogCount: worklogEntries.length,
  });
  const syncGenerationId = `elitical-sync-${syncGenerationSequence}-${snapshotHash.slice(0, 12)}`;

  return {
    schemaVersion: 1,
    snapshotId: syncGenerationId,
    syncGenerationId,
    syncGenerationSequence,
    syncedAt: effectiveSyncedAt,
    createdAt,
    graphHash,
    worklogsHash,
    nodeCount: graph?.appState?.workItems?.length || 0,
    worklogCount: worklogEntries.length,
    employee: defaultEmployeeFromWorklogs(worklogEntries),
  };
}

export function snapshotDescriptorFor(payload = {}) {
  const snapshot = payload?.snapshot || payload?.synchronizedSnapshot || {};
  const snapshotId = firstString(
    payload?.snapshotId,
    payload?.syncGenerationId,
    snapshot?.snapshotId,
    snapshot?.syncGenerationId
  );
  const sequence = Number(
    payload?.syncGenerationSequence ??
      snapshot?.syncGenerationSequence ??
      Date.parse(payload?.lastSuccessfulSync || payload?.lastSyncTime || snapshot?.syncedAt || "")
  );

  return {
    snapshotId,
    syncGenerationId: firstString(payload?.syncGenerationId, snapshot?.syncGenerationId, snapshotId),
    syncGenerationSequence: Number.isFinite(sequence) ? sequence : 0,
    syncedAt: firstString(snapshot?.syncedAt, payload?.lastSuccessfulSync, payload?.lastSyncTime),
    employee: payload?.employee || snapshot?.employee || null,
  };
}

export function applySnapshotToGraph(graph = {}, snapshot = {}) {
  return {
    ...graph,
    snapshotId: snapshot.snapshotId,
    syncGenerationId: snapshot.syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    appState: {
      ...(graph.appState || {}),
      metadata: {
        ...(graph.appState?.metadata || {}),
        snapshotId: snapshot.snapshotId,
        syncGenerationId: snapshot.syncGenerationId,
        syncGenerationSequence: snapshot.syncGenerationSequence,
        employee: snapshot.employee || graph.appState?.metadata?.employee || null,
      },
      employee: snapshot.employee || graph.appState?.employee || null,
    },
  };
}

export function applySnapshotToWorklogs(worklogs = {}, snapshot = {}) {
  return {
    ...worklogs,
    snapshotId: snapshot.snapshotId,
    syncGenerationId: snapshot.syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    employee: snapshot.employee || worklogs.employee || null,
  };
}

export function applySnapshotToMetadata(metadata = {}, snapshot = {}) {
  return {
    ...metadata,
    snapshotId: snapshot.snapshotId,
    syncGenerationId: snapshot.syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    employee: snapshot.employee || metadata.employee || null,
  };
}

export function buildFinalizedSnapshot({ graph, worklogs, metadata, syncedAt } = {}) {
  const snapshot = buildSnapshotDescriptor({ graph, worklogs, metadata, syncedAt });
  const finalizedGraph = applySnapshotToGraph(graph, snapshot);
  const finalizedWorklogs = applySnapshotToWorklogs(worklogs, snapshot);

  return {
    snapshot,
    graph: finalizedGraph,
    worklogs: finalizedWorklogs,
  };
}

export function snapshotIdsMatch(...payloads) {
  const ids = payloads
    .map((payload) => snapshotDescriptorFor(payload).syncGenerationId)
    .filter(Boolean);

  return ids.length <= 1 || ids.every((id) => id === ids[0]);
}

export function assertSnapshotBundle({ graph, worklogs, metadata } = {}) {
  if (!graph || !worklogs || !metadata) {
    throw new Error("Published snapshot requires graph, worklogs, and metadata.");
  }

  const descriptors = [graph, worklogs, metadata].map(snapshotDescriptorFor);
  const ids = descriptors.map((descriptor) => descriptor.syncGenerationId).filter(Boolean);

  if (ids.length > 0 && ids.length < 3) {
    throw new Error("Snapshot generation metadata is incomplete.");
  }

  if (ids.length === 3 && !ids.every((id) => id === ids[0])) {
    throw new Error("Snapshot generation mismatch between graph, worklogs, and metadata.");
  }

  return {
    consistent: ids.length === 3,
    snapshotId: ids[0] || "",
    descriptors,
  };
}
