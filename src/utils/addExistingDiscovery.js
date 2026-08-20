import {
  ORPHAN_SPRINT_ID,
  isReferenceNode,
} from "./hierarchyProjection.js";
import {
  dayEpicScopeKey,
  dayScopeIdForItem,
} from "./dayViewProjection.js";

function normalizedText(value) {
  return String(value || "").trim().toLowerCase();
}

function isCanonicalCandidate(item) {
  return Boolean(item && !item.isVirtual && !isReferenceNode(item));
}

function candidateSearchFields(item) {
  return [
    item.title,
    item.elitical?.num,
    item.elitical?.remoteId,
    item.sync?.remoteId,
    item.sourceItemId,
    item.sourceDocketId,
    item.sourceId,
    item.id,
    item.description,
  ];
}

function canonicalDuplicateForDestination(item, request, scopeId) {
  if (request?.type === "epic") {
    return dayScopeIdForItem(item) === scopeId;
  }

  if (request?.type === "story") {
    return Boolean(request.parentId && item.parentId === request.parentId);
  }

  return false;
}

function dayDuplicateIdsForDestination({ request, daySelection, scopeId }) {
  if (request?.type === "story") {
    return new Set(
      daySelection?.storiesByEpicScope?.[
        dayEpicScopeKey(request.parentId, scopeId)
      ] || []
    );
  }

  if (request?.type === "epic") {
    return new Set(daySelection?.epicsBySprint?.[scopeId] || []);
  }

  return new Set();
}

export function addExistingDiscoveryScopeId(request) {
  return request?.isOrphanSprint
    ? ORPHAN_SPRINT_ID
    : request?.sprintId || ORPHAN_SPRINT_ID;
}

export function discoverAddExistingItems({
  workItems = [],
  request,
  query = "",
  daySelection = {},
  scopeId = addExistingDiscoveryScopeId(request),
} = {}) {
  const type = request?.type || "";
  const normalizedQuery = normalizedText(query);
  const isDayMode = request?.mode === "day";
  const alreadySelected = isDayMode
    ? dayDuplicateIdsForDestination({ request, daySelection, scopeId })
    : new Set();

  return workItems
    .filter((item) => {
      if (!isCanonicalCandidate(item)) return false;
      if (item.type !== type) return false;
      if (alreadySelected.has(item.id)) return false;

      if (!isDayMode && canonicalDuplicateForDestination(item, request, scopeId)) {
        return false;
      }

      if (!normalizedQuery) return true;

      return candidateSearchFields(item).some((value) =>
        normalizedText(value).includes(normalizedQuery)
      );
    })
    .sort((first, second) =>
      String(first.title || "").localeCompare(String(second.title || ""))
    );
}
