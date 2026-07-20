import { dateKeyFromValue } from "./dayViewProjection.js";

export const RETAINED_CREATION_CONTEXT_STORAGE_KEY =
  "elitical-worklog.retained-creation-context.v1";

function normalizeContextId(viewMode, contextId) {
  if (viewMode === "day") return dateKeyFromValue(contextId);

  return String(contextId || "").trim();
}

export function normalizeRetainedCreationContextState(value) {
  const input = value && typeof value === "object" ? value : {};
  const contexts = Array.isArray(input.contexts) ? input.contexts : [];
  const byKey = new Map();

  contexts.forEach((context) => {
    if (!context || typeof context !== "object") return;

    const viewMode = String(context.viewMode || "").trim();
    const contextId = normalizeContextId(viewMode, context.contextId);
    const nodeId = String(context.nodeId || "").trim();

    if (!viewMode || !contextId || !nodeId) return;

    byKey.set(`${viewMode}:${contextId}:${nodeId}`, {
      viewMode,
      contextId,
      nodeId,
      parentId: String(context.parentId || "").trim(),
      sprintId: String(context.sprintId || "").trim(),
      createdAt: context.createdAt || "",
    });
  });

  return {
    version: 1,
    contexts: Array.from(byKey.values()),
  };
}

export function loadRetainedCreationContextState(storage) {
  if (!storage) return normalizeRetainedCreationContextState();

  try {
    return normalizeRetainedCreationContextState(
      JSON.parse(storage.getItem(RETAINED_CREATION_CONTEXT_STORAGE_KEY) || "{}")
    );
  } catch {
    return normalizeRetainedCreationContextState();
  }
}

export function saveRetainedCreationContextState(storage, state) {
  if (!storage) return;

  storage.setItem(
    RETAINED_CREATION_CONTEXT_STORAGE_KEY,
    JSON.stringify(normalizeRetainedCreationContextState(state))
  );
}

export function addRetainedCreationContext({
  state,
  viewMode,
  contextId,
  nodeId,
  parentId = "",
  sprintId = "",
}) {
  const normalized = normalizeRetainedCreationContextState(state);
  const normalizedViewMode = String(viewMode || "").trim();
  const normalizedContextId = normalizeContextId(normalizedViewMode, contextId);
  const normalizedNodeId = String(nodeId || "").trim();

  if (!normalizedViewMode || !normalizedContextId || !normalizedNodeId) {
    return normalized;
  }

  return normalizeRetainedCreationContextState({
    version: 1,
    contexts: [
      ...normalized.contexts,
      {
        viewMode: normalizedViewMode,
        contextId: normalizedContextId,
        nodeId: normalizedNodeId,
        parentId,
        sprintId,
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

export function retainedNodeIdsForContext({
  state,
  viewMode,
  contextId,
}) {
  const normalizedViewMode = String(viewMode || "").trim();
  const normalizedContextId = normalizeContextId(normalizedViewMode, contextId);

  if (!normalizedViewMode || !normalizedContextId) return [];

  return normalizeRetainedCreationContextState(state).contexts
    .filter(
      (context) =>
        context.viewMode === normalizedViewMode &&
        context.contextId === normalizedContextId
    )
    .map((context) => context.nodeId);
}

export function removeRetainedCreationContexts(state, nodeIds = []) {
  const removeIds = new Set(
    (Array.isArray(nodeIds) ? nodeIds : [nodeIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );

  if (removeIds.size === 0) return normalizeRetainedCreationContextState(state);

  return normalizeRetainedCreationContextState({
    version: 1,
    contexts: normalizeRetainedCreationContextState(state).contexts.filter(
      (context) => !removeIds.has(context.nodeId)
    ),
  });
}

export function clearRetainedCreationContexts() {
  return normalizeRetainedCreationContextState();
}
