function titleCase(value) {
  const text = String(value || "")
    .replace(/[-_]/g, " ")
    .trim();

  if (!text) return "-";

  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function safeText(value, fallback = "") {
  const text = String(value || fallback || "").trim();

  if (!text) return "";
  if (/(authorization|cookie|jwt|token|session|password|secret)/i.test(text)) {
    return "Hidden";
  }

  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return "";
}

function operationDisplayTitle(operation = {}) {
  return safeText(
    firstString(
      operation.payload?.title,
      operation.payload?.name,
      operation.title,
      operation.name,
      operation.payload?.comment,
      operation.payload?.description,
      operation.localId,
      operation.operationId
    ),
    "Untitled item"
  );
}

function operationError(operation = {}) {
  return safeText(
    firstString(
      operation.lastError,
      operation.error,
      operation.message,
      operation.payload?.error,
      operation.payload?.message
    ),
    "-"
  );
}

function parentTitleFor(operation = {}, operations = []) {
  const parentId = firstString(operation.dependsOn, operation.docketId, operation.payload?.docketId);

  if (!parentId) return "";

  const parent = operations.find((candidate) =>
    firstString(candidate.localId, candidate.remoteId, candidate.payload?.id) === parentId
  );

  return parent ? operationDisplayTitle(parent) : "";
}

export function summarizeSyncOperation(operation = {}, operations = []) {
  const entity = firstString(operation.entityType, operation.docketType, operation.payload?.type);
  const docketId = firstString(
    operation.remoteId,
    operation.payload?.remoteId,
    operation.payload?.id,
    operation.docketId,
    operation.localId
  );
  const dependencyBlocked = Boolean(
    operation.classification?.dependencyBlocked ||
      operation.status === "dependency-blocked" ||
      firstString(operation.dependsOn)
  );
  const blockedDependent = operations.find((candidate) =>
    candidate.entityType === "worklog" &&
    candidate.operation === "create" &&
    candidate.status === "dependency-blocked" &&
    firstString(candidate.dependsOn) === firstString(operation.localId)
  );

  return {
    operationId: firstString(operation.operationId),
    entityType: firstString(operation.entityType),
    operationType: firstString(operation.operation),
    localId: firstString(operation.localId),
    title: operationDisplayTitle(operation),
    entityLabel: titleCase(entity),
    operationLabel: titleCase(operation.operation),
    statusLabel: titleCase(operation.status),
    docketTypeLabel: titleCase(operation.docketType || operation.payload?.type),
    docketId,
    error: operationError(operation),
    reason: dependencyBlocked
      ? "Waiting for parent Docket to sync."
      : operationError(operation),
    parentTitle: dependencyBlocked ? parentTitleFor(operation, operations) : "",
    duplicateRecovery: blockedDependent
      ? {
          eligible: operation.entityType === "docket" &&
            operation.operation === "create" &&
            operation.status === "sync-failed",
          parentOperationId: firstString(operation.operationId),
          dependentOperationId: firstString(blockedDependent.operationId),
        }
      : null,
  };
}

export function syncDirectionLabel(direction, { hasOutboundQueueActivity = false } = {}) {
  if (direction === "outbound") return "Sync to Elitical";
  if (direction === "inbound") return hasOutboundQueueActivity ? "Combined Sync" : "Sync from Elitical";
  if (direction === "local") return "Local Save";

  return hasOutboundQueueActivity ? "Sync to Elitical" : "Idle";
}

export function buildSyncStatusPresentation({
  activity = {},
  queueSummary = {},
  summary = {},
  liveState = "idle",
} = {}) {
  const operations = Array.isArray(queueSummary.operations) ? queueSummary.operations : [];
  const failedOperations = operations
    .filter((operation) => operation.status === "sync-failed")
    .map((operation) => summarizeSyncOperation(operation, operations));
  const blockedOperations = operations
    .filter((operation) =>
      operation.status !== "sync-failed" &&
      (operation.classification?.blocked || operation.status === "dependency-blocked")
    )
    .map((operation) => summarizeSyncOperation(operation, operations));
  const hasFailures = failedOperations.length > 0;
  const hasBlocked = blockedOperations.length > 0;
  const hasOutboundQueueActivity = operations.some((operation) => operation.status !== "synced");
  const isRunning = activity.state === "running" || liveState === "syncing";
  const baseStatus = summary.status || (liveState === "failed" ? "Failed" : "Success");
  const status = isRunning
    ? "Syncing"
    : hasFailures
    ? "Failed"
    : hasBlocked
    ? "Needs Attention"
    : Number(queueSummary.actionableCount || 0) > 0
    ? "Pending"
    : baseStatus;

  return {
    status,
    directionLabel: syncDirectionLabel(activity.direction, { hasOutboundQueueActivity }),
    activityMessage: activity.message || "Idle",
    failedOperations,
    blockedOperations,
    hasFailures,
    hasBlocked,
  };
}
