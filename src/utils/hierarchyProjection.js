import { ROOT_ID } from "./worklogModel.js";

const DEFAULT_REFERENCE_SCOPE = "view";
export const ORPHAN_SPRINT_ID = "virtual-orphan-sprint";
export const ORPHAN_SPRINT_TITLE = "Orphan Sprint";

export function sprintScopeIdForItem(item) {
  return item?.elitical?.sprintId || item?.sprintId || "";
}

export function isOrphanSprintId(id) {
  return id === ORPHAN_SPRINT_ID;
}

export function isOrphanSprintScope(scope) {
  return Boolean(scope?.isOrphanSprint || isOrphanSprintId(scope?.id));
}

export function orphanSprintScope() {
  return {
    id: ORPHAN_SPRINT_ID,
    title: ORPHAN_SPRINT_TITLE,
    name: ORPHAN_SPRINT_TITLE,
    docketState: "concept",
    sprintState: "NO_SPRINT",
    state: "NO_SPRINT",
    isVirtual: true,
    isOrphanSprint: true,
    isSprintNode: true,
  };
}

export function projectionScopeIdForItem(item, scopeIdForItem = sprintScopeIdForItem) {
  if (!item || item.isVirtual || isReferenceNode(item)) return "";

  return scopeIdForItem(item) || ORPHAN_SPRINT_ID;
}

export function hasOrphanSprintItems(items = [], scopeIdForItem = sprintScopeIdForItem) {
  return items.some(
    (item) =>
      item &&
      !item.isVirtual &&
      !isReferenceNode(item) &&
      ["epic", "story", "job", "task"].includes(item.type) &&
      !scopeIdForItem(item)
  );
}

export function scopesWithOrphanSprint(
  scopes = [],
  items = [],
  { scopeIdForItem = sprintScopeIdForItem, include = false } = {}
) {
  const shouldInclude = include || hasOrphanSprintItems(items, scopeIdForItem);
  const realScopes = scopes.filter((scope) => scope?.id !== ORPHAN_SPRINT_ID);

  if (!shouldInclude) return realScopes;

  return [...realScopes, orphanSprintScope()];
}

export function referenceNodeId(sourceId, scopeId, type = "item") {
  return `reference-${type}-${sourceId}-${scopeId || DEFAULT_REFERENCE_SCOPE}`;
}

export function isReferenceNode(item) {
  return Boolean(item?.isReference || item?.isGhost);
}

function canonicalItemId(item) {
  return item?.sourceItemId || item?.sourceDocketId || item?.sourceId || item?.id || "";
}

function ancestorChainForItem(item, itemById, rootId) {
  const chain = [];
  const visited = new Set();
  let parentId = item?.parentId;

  while (parentId && parentId !== rootId) {
    if (visited.has(parentId)) break;
    visited.add(parentId);

    const parent = itemById.get(parentId);

    if (!parent) break;

    chain.unshift(parent);
    parentId = parent.parentId;
  }

  return chain;
}

function scopeTitle(scopeById, scopeId) {
  return scopeById.get(scopeId)?.title || scopeById.get(scopeId)?.name || "";
}

export function buildProjectedHierarchy({
  items = [],
  allItems = items,
  scopes = [],
  rootId = ROOT_ID,
  enabled = true,
  includeMissingAncestors = true,
  scopeIdForItem = sprintScopeIdForItem,
} = {}) {
  if (!enabled) {
    return {
      items,
      referenceItems: [],
    };
  }

  const projectedScopes = scopesWithOrphanSprint(scopes, allItems, {
    scopeIdForItem,
  });
  const scopeById = new Map(
    projectedScopes
      .filter((scope) => scope?.id && scope.id !== rootId)
      .map((scope) => [scope.id, scope])
  );
  const allItemById = new Map(allItems.map((item) => [item.id, item]));
  const visibleIds = new Set(items.map((item) => item.id));
  const projectedById = new Map(items.map((item) => [item.id, item]));
  const referencesById = new Map();

  function ensureReference(source, scopeId, parentId) {
    const sourceId = canonicalItemId(source);
    const id = referenceNodeId(sourceId, scopeId, source.type);

    if (referencesById.has(id)) return referencesById.get(id);

    const title = scopeTitle(scopeById, scopeId);
    const isOrphanScope = isOrphanSprintId(scopeId);
    const reference = {
      ...source,
      id,
      sourceId: id,
      sourceItemId: sourceId,
      sourceDocketId: sourceId,
      targetScopeId: scopeId || "",
      targetSprintId: scopeId || "",
      parentId,
      visualParentId: parentId === rootId && scopeId ? scopeId : parentId,
      sprint: title || source.sprint || "",
      sprintId: isOrphanScope ? "" : scopeId || source.sprintId || "",
      isReference: true,
      isGhost: true,
      isVirtual: true,
      isOrphanSprintContext: isOrphanScope,
      allowChildActions: source.type === "epic" || source.type === "story",
      childParentId: sourceId,
      childSprintId: isOrphanScope ? "" : scopeId || "",
      childSprint: title || source.sprint || "",
      completedSummaryControls: [],
      expandedSummaryId: undefined,
      hiddenChildIds: undefined,
      hiddenCount: undefined,
      hiddenRootCount: undefined,
      isCompletedSummary: false,
    };

    referencesById.set(id, reference);
    return reference;
  }

  items.forEach((item) => {
    if (!item || item.isVirtual || isReferenceNode(item)) return;

    const itemScopeId = projectionScopeIdForItem(item, scopeIdForItem);
    const hasKnownScope = Boolean(itemScopeId && scopeById.has(itemScopeId));
    const chain = ancestorChainForItem(item, allItemById, rootId);
    const itemScopeTitle = scopeTitle(scopeById, itemScopeId);
    const itemIsOrphanScope = isOrphanSprintId(itemScopeId);
    const scopedItemFields = hasKnownScope
      ? {
          visualParentId:
            (item.parentId || rootId) === rootId
              ? itemScopeId
              : item.visualParentId,
          targetScopeId: itemScopeId,
          targetSprintId: itemScopeId,
          childSprintId: itemIsOrphanScope ? "" : itemScopeId,
          childSprint: itemScopeTitle || item.sprint || "",
          isOrphanSprintContext: itemIsOrphanScope,
        }
      : {};

    if (hasKnownScope) {
      projectedById.set(item.id, {
        ...item,
        ...scopedItemFields,
      });
    }

    if (chain.length === 0) return;

    let projectedParentId = rootId;
    let nearestVisibleOrReferenceParentId = item.parentId;

    chain.forEach((ancestor) => {
      const ancestorScopeId = projectionScopeIdForItem(ancestor, scopeIdForItem);
      const isVisibleAncestor = visibleIds.has(ancestor.id);
      const needsScopeReference =
        hasKnownScope && ancestorScopeId !== itemScopeId;
      const needsMissingAncestorReference =
        includeMissingAncestors && !isVisibleAncestor;

      if (needsScopeReference || needsMissingAncestorReference) {
        const reference = ensureReference(ancestor, itemScopeId, projectedParentId);
        projectedParentId = reference.id;
        nearestVisibleOrReferenceParentId = reference.id;
        return;
      }

      projectedParentId = ancestor.id;
      nearestVisibleOrReferenceParentId = ancestor.id;
    });

    if (
      nearestVisibleOrReferenceParentId &&
      nearestVisibleOrReferenceParentId !== item.parentId
    ) {
      projectedById.set(item.id, {
        ...item,
        ...scopedItemFields,
        parentId: nearestVisibleOrReferenceParentId,
        visualParentId: nearestVisibleOrReferenceParentId,
        canonicalParentId: item.parentId,
      });
    }
  });

  const referenceItems = Array.from(referencesById.values());
  const referenceSourceIds = new Set(
    referenceItems.map((reference) => reference.sourceItemId).filter(Boolean)
  );
  const projectedItems = items.map((item) => projectedById.get(item.id) || item);
  const parentIdsWithVisibleChildren = new Set(
    projectedItems
      .map((item) => item.visualParentId || item.parentId)
      .filter(Boolean)
  );
  const visibleCanonicalItems = projectedItems.filter((item) => {
    if (!referenceSourceIds.has(item.id)) return true;
    if (projectionScopeIdForItem(item, scopeIdForItem) === ORPHAN_SPRINT_ID) {
      return true;
    }

    return parentIdsWithVisibleChildren.has(item.id);
  });

  return {
    items: [
      ...visibleCanonicalItems,
      ...referenceItems,
    ],
    referenceItems,
  };
}
