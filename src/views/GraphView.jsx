import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactFlow, {
  Background,
  useNodesState,
} from "reactflow";

import "reactflow/dist/style.css";

import JiraNode from "../components/JiraNode";
import {
  getLayoutedElements,
  getNodeSize,
} from "../utils/dagreLayout";
import { ROOT_ID } from "../utils/worklogModel";

const nodeTypes = {
  jiraNode: JiraNode,
  separatorGuide: SeparatorGuide,
};

const edgeTypes = {
  parentBranch: ParentBranchEdge,
};

const MAIN_ROOT_ID = "mainRoot";
const CONNECTOR_STROKE_WIDTH = 1.8;
const CONNECTOR_CORNER_RADIUS = 10;
const EXPANDED_COMPLETED_SUMMARIES_KEY =
  "elitical-worklog.expanded-completed-summaries.v1";
const COMPLETED_STATES = new Set(["closed", "artifact"]);

function normalizeState(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function isCompletedItem(item) {
  return COMPLETED_STATES.has(normalizeState(item?.docketState || item?.status));
}

function loadExpandedSummaryIds() {
  if (typeof window === "undefined") return new Set();

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(EXPANDED_COMPLETED_SUMMARIES_KEY) || "[]"
    );

    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveExpandedSummaryIds(summaryIds) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(
    EXPANDED_COMPLETED_SUMMARIES_KEY,
    JSON.stringify(Array.from(summaryIds).sort())
  );
}

function summaryIdFor(parentId, type, scope = "") {
  return `completed-summary:${parentId || ROOT_ID}:${type || "items"}:${scope || "all"}`;
}

function summaryLabelFor(type) {
  if (type === "job") return "Completed Jobs";
  if (type === "story") return "Completed Stories";
  if (type === "epic") return "Completed Epics";
  if (type === "task") return "Completed Tasks";
  return "Completed Items";
}

function itemMatchesSearch(item, query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) return false;

  return [
    item.title,
    item.description,
    item.type,
    item.category,
    item.priority,
    item.docketState,
    item.sprint,
    item.id,
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function descendantIdsFor(itemId, childrenByParent) {
  const ids = [];
  const pending = [...(childrenByParent.get(itemId) || [])];

  while (pending.length) {
    const child = pending.shift();
    ids.push(child.id);
    pending.push(...(childrenByParent.get(child.id) || []));
  }

  return ids;
}

function prepareCompletedCollapse({
  workItems,
  expandedSummaryIds,
  searchQuery,
  storyPointTotals,
}) {
  const childrenByParent = workItems.reduce((acc, item) => {
    const parentId = item.parentId || ROOT_ID;
    if (!acc.has(parentId)) acc.set(parentId, []);
    acc.get(parentId).push(item);
    return acc;
  }, new Map());
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const branchCompletion = new Map();
  const searchMatches = new Set();

  workItems.forEach((item) => {
    if (itemMatchesSearch(item, searchQuery)) searchMatches.add(item.id);
  });

  function isCompletedBranch(item) {
    if (branchCompletion.has(item.id)) return branchCompletion.get(item.id);

    const complete =
      isCompletedItem(item) &&
      (childrenByParent.get(item.id) || []).every(isCompletedBranch);

    branchCompletion.set(item.id, complete);
    return complete;
  }

  function branchContainsSearch(item) {
    if (!searchQuery.trim()) return false;
    if (searchMatches.has(item.id)) return true;

    return descendantIdsFor(item.id, childrenByParent).some((id) =>
      searchMatches.has(id)
    );
  }

  const visible = [];
  const summaryControlsByParent = new Map();
  const summaryIds = new Set();
  function addControl(parentId, summary) {
    summaryIds.add(summary.id);

    if (!summaryControlsByParent.has(parentId)) {
      summaryControlsByParent.set(parentId, []);
    }
    summaryControlsByParent.get(parentId).push(summary);
  }

  function appendChildren(parentId, forceVisible = false) {
    const children = childrenByParent.get(parentId) || [];
    const collapsedGroups = new Map();

    children.forEach((child) => {
      if (
        forceVisible ||
        child.isContextPrimary ||
        child.isContextNode ||
        !isCompletedBranch(child)
      ) {
        visible.push(child);
        appendChildren(child.id, forceVisible);
        return;
      }

      const scope = parentId === ROOT_ID ? child.sprint || "root" : "";
      const summaryId = summaryIdFor(parentId, child.type, scope);
      const explicitlyExpanded = expandedSummaryIds.has(summaryId);
      const shouldExpand =
        explicitlyExpanded || branchContainsSearch(child);

      if (shouldExpand) {
        addControl(parentId, {
          id: summaryId,
          type: child.type,
          count: 0,
          expanded: explicitlyExpanded,
        });
        visible.push({
          ...child,
          expandedSummaryId: explicitlyExpanded
            ? summaryId
            : undefined,
        });
        appendChildren(child.id, explicitlyExpanded);
        return;
      }

      const groupKey = JSON.stringify({
        type: child.type,
        sprint: parentId === ROOT_ID ? child.sprint || "" : "",
      });

      if (!collapsedGroups.has(groupKey)) {
        collapsedGroups.set(groupKey, []);
      }

      collapsedGroups.get(groupKey).push(child);
    });

    collapsedGroups.forEach((items, groupKey) => {
      const { type, sprint } = JSON.parse(groupKey);
      const summaryId = summaryIdFor(
        parentId,
        type,
        parentId === ROOT_ID ? sprint || "root" : ""
      );
      const hiddenIds = items.flatMap((item) => [
        item.id,
        ...descendantIdsFor(item.id, childrenByParent),
      ]);
      const latestUpdatedAt = items.reduce((latest, item) => {
        const itemTime = new Date(item.updatedAt || item.createdAt || 0).getTime();
        const latestTime = new Date(latest || 0).getTime();

        return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
      }, "");
      const summaryWorklogIds = new Set();

      items.forEach((item) => {
        (storyPointTotals.worklogIdsById?.[item.id] || new Set()).forEach((id) =>
          summaryWorklogIds.add(id)
        );
      });
      const hiddenTimeMinutes = Array.from(summaryWorklogIds).reduce(
        (total, id) =>
          total + Number(storyPointTotals.worklogMinutesById?.[id] || 0),
        0
      );
      const hiddenStoryPoints = hiddenIds.reduce((total, id) => {
        const item = itemById.get(id);
        return total + Number(item?.storyPoints || 0);
      }, 0);
      const summary = {
        id: summaryId,
        title: summaryLabelFor(type),
        type: "completed-summary",
        summaryType: type,
        parentId,
        sprint,
        docketState: "artifact",
        updatedAt: latestUpdatedAt,
        createdAt: latestUpdatedAt,
        hiddenChildIds: hiddenIds,
        hiddenCount: hiddenIds.length,
        hiddenRootCount: items.length,
        hiddenTimeMinutes,
        hiddenStoryPoints,
        isVirtual: true,
        isCompletedSummary: true,
      };

      visible.push(summary);
      addControl(parentId, {
        id: summaryId,
        type,
        count: hiddenIds.length,
        expanded: false,
      });
    });
  }

  appendChildren(ROOT_ID);

  return {
    workItems: visible,
    summaryControlsByParent,
    summaryIds,
    searchMatchIds: searchMatches,
  };
}

function SeparatorGuide({ data }) {
  return (
    <div
      className="tree-separator-guide"
      style={{ height: `${data.height}px` }}
    />
  );
}

function roundedCornerBranchPath(points) {
  const uniquePoints = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  const [start, ...rest] = uniquePoints;
  const segments = [`M ${start.x} ${start.y}`];

  rest.forEach((point, index) => {
    const previous = uniquePoints[index];
    const next = rest[index + 1];

    if (!next) {
      segments.push(`L ${point.x} ${point.y}`);
      return;
    }

    const incomingX = point.x - previous.x;
    const incomingY = point.y - previous.y;
    const outgoingX = next.x - point.x;
    const outgoingY = next.y - point.y;

    if (
      (incomingX !== 0 && outgoingX !== 0) ||
      (incomingY !== 0 && outgoingY !== 0)
    ) {
      segments.push(`L ${point.x} ${point.y}`);
      return;
    }

    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);

    if (incomingLength === 0 || outgoingLength === 0) {
      segments.push(`L ${point.x} ${point.y}`);
      return;
    }

    const cornerRadius = Math.min(
      CONNECTOR_CORNER_RADIUS,
      incomingLength / 2,
      outgoingLength / 2
    );
    const before = {
      x: point.x - (incomingX / incomingLength) * cornerRadius,
      y: point.y - (incomingY / incomingLength) * cornerRadius,
    };
    const after = {
      x: point.x + (outgoingX / outgoingLength) * cornerRadius,
      y: point.y + (outgoingY / outgoingLength) * cornerRadius,
    };

    segments.push(`L ${before.x} ${before.y}`);
    segments.push(`Q ${point.x} ${point.y} ${after.x} ${after.y}`);
  });

  return segments.join(" ");
}

const DOCKET_STATE_COLORS = {
  concept: "#22C55E",
  artifact: "#6B7280",
  design: "#EAB308",
  review: "#F97316",
  closed: "#1E3A8A",
};

function edgeColorFor(item) {
  return DOCKET_STATE_COLORS[item.docketState || "concept"];
}

function itemForNode(id, node, itemById) {
  if (id === ROOT_ID || id === MAIN_ROOT_ID) {
    return node?.data || {};
  }

  return itemById.get(id) || {};
}

function visualParentIdForItem(item, includeMainRoot, sprints = []) {
  if (!includeMainRoot || item.parentId !== ROOT_ID) return item.parentId;

  const sprint = sprints.find(
    (entry) => entry.id !== ROOT_ID && entry.title === item.sprint
  );

  return sprint?.id || ROOT_ID;
}

function ParentBranchEdge({ data }) {
  return (
    <g className="react-flow__edge branch-connector-edge">
      {(data?.segments || []).map((segment, index) => (
        <path
          key={index}
          d={segment.path}
          fill="none"
          stroke={segment.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={CONNECTOR_STROKE_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

function buildLayoutEdges(
  workItems,
  includeRootNode,
  includeMainRoot = false,
  sprints = []
) {
  const visibleIds = new Set(workItems.map((item) => item.id));
  const extraSprintIds = sprints
    .filter((sprint) => sprint.id !== ROOT_ID)
    .map((sprint) => sprint.id);
  const workEdges = workItems
    .filter(
      (item) =>
        visibleIds.has(item.parentId) ||
        (includeRootNode && item.parentId === ROOT_ID)
    )
    .map((item) => {
      const source = visualParentIdForItem(item, includeMainRoot, sprints);

      return {
        id: `${source}-${item.id}`,
        source,
        target: item.id,
      };
    });

  return includeMainRoot
    ? [
        {
          id: `${MAIN_ROOT_ID}-${ROOT_ID}`,
          source: MAIN_ROOT_ID,
          target: ROOT_ID,
        },
        ...extraSprintIds.map((id) => ({
          id: `${MAIN_ROOT_ID}-${id}`,
          source: MAIN_ROOT_ID,
          target: id,
        })),
        ...workEdges,
      ]
    : workEdges;
}

function getNodeCenterX(node) {
  const size = getNodeSize(node);
  return node.position.x + size.width / 2;
}

function getNodeBottomY(node) {
  const size = getNodeSize(node);
  return node.position.y + size.height;
}

function straightPath(from, to) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function connectorPathForChild(parent, child, branchY) {
  const parentCenterX = getNodeCenterX(parent);
  const parentBottomY = getNodeBottomY(parent);
  const childCenterX = getNodeCenterX(child);
  const childTopY = child.position.y;

  if (Math.abs(parentCenterX - childCenterX) < 1) {
    return `M ${parentCenterX} ${parentBottomY} L ${childCenterX} ${childTopY}`;
  }

  return roundedCornerBranchPath([
    {
      x: parentCenterX,
      y: parentBottomY,
    },
    {
      x: parentCenterX,
      y: branchY,
    },
    {
      x: childCenterX,
      y: branchY,
    },
    {
      x: childCenterX,
      y: childTopY,
    },
  ]);
}

function buildBranchConnectorEdges(
  nodes,
  workItems,
  includeRootNode,
  rootNodeId,
  sprints = []
) {
  const workNodes = nodes.filter(isWorkNode);
  const nodeById = new Map(workNodes.map((node) => [node.id, node]));
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const extraSprintIds = sprints
    .filter((sprint) => sprint.id !== ROOT_ID)
    .map((sprint) => sprint.id);
  const visibleIds = new Set(workItems.map((item) => item.id));
  const childrenByParent = workItems.reduce((acc, item) => {
    if (
      visibleIds.has(item.parentId) ||
      (includeRootNode && item.parentId === ROOT_ID)
    ) {
      const parentId = visualParentIdForItem(item, includeRootNode, sprints);

      if (!acc[parentId]) acc[parentId] = [];
      acc[parentId].push(item.id);
    }

    return acc;
  }, {});

  if (includeRootNode && nodeById.has(MAIN_ROOT_ID) && nodeById.has(ROOT_ID)) {
    childrenByParent[MAIN_ROOT_ID] = [ROOT_ID, ...extraSprintIds];
  }

  return Array.from(
    new Set([
      rootNodeId,
      ...(includeRootNode ? [MAIN_ROOT_ID, ROOT_ID] : []),
      ...extraSprintIds,
      ...workItems.map((item) => item.parentId),
    ])
  ).flatMap((parentId) => {
    const parent = nodeById.get(parentId);
    const childIds = childrenByParent[parentId] || [];
    const children = childIds
      .map((id) => nodeById.get(id))
      .filter(Boolean)
      .sort((first, second) => getNodeCenterX(first) - getNodeCenterX(second));

    if (!parent || children.length === 0) return [];

    const parentBottomY = getNodeBottomY(parent);
    const nearestChildTopY = Math.min(
      ...children.map((child) => child.position.y)
    );
    const availableGap = nearestChildTopY - parentBottomY;
    const branchY =
      availableGap > 8
        ? parentBottomY + Math.min(38, Math.max(8, availableGap / 2))
        : parentBottomY;
    const parentCenterX = getNodeCenterX(parent);

    if (children.length === 1) {
      const child = children[0];
      const childItem = itemForNode(child.id, child, itemById);

      return [
        {
          id: `branch:${parentId}`,
          source: parentId,
          target: child.id,
          type: "parentBranch",
          data: {
            segments: [
              {
                color: edgeColorFor(childItem || {}),
                path: connectorPathForChild(parent, child, branchY),
              },
            ],
          },
        },
      ];
    }

    const leftChild = children[0];
    const rightChild = children[children.length - 1];
    const leftX = getNodeCenterX(leftChild);
    const rightX = getNodeCenterX(rightChild);
    const junctionX = Math.max(leftX, Math.min(parentCenterX, rightX));
    const trunkPath = roundedCornerBranchPath([
      {
        x: parentCenterX,
        y: parentBottomY,
      },
      {
        x: parentCenterX,
        y: branchY,
      },
      {
        x: junctionX,
        y: branchY,
      },
    ]);
    const leftArmPath =
      Math.abs(junctionX - leftX) < 1
        ? straightPath(
            {
              x: leftX,
              y: branchY,
            },
            {
              x: leftX,
              y: leftChild.position.y,
            }
          )
        : roundedCornerBranchPath([
            {
              x: junctionX,
              y: branchY,
            },
            {
              x: leftX,
              y: branchY,
            },
            {
              x: leftX,
              y: leftChild.position.y,
            },
          ]);
    const rightArmPath =
      Math.abs(rightX - junctionX) < 1
        ? straightPath(
            {
              x: rightX,
              y: branchY,
            },
            {
              x: rightX,
              y: rightChild.position.y,
            }
          )
        : roundedCornerBranchPath([
            {
              x: junctionX,
              y: branchY,
            },
            {
              x: rightX,
              y: branchY,
            },
            {
              x: rightX,
              y: rightChild.position.y,
            },
          ]);
    const middleStemSegments = children.slice(1, -1).map((child) => {
      const childCenterX = getNodeCenterX(child);
      return {
        color: edgeColorFor(itemForNode(child.id, child, itemById)),
        path: straightPath(
          {
            x: childCenterX,
            y: branchY,
          },
          {
            x: childCenterX,
            y: child.position.y,
          }
        ),
      };
    });
    const firstChildItem = itemForNode(leftChild.id, leftChild, itemById);

    return [
      {
        id: `branch:${parentId}`,
        source: parentId,
        target: children[0].id,
        type: "parentBranch",
        data: {
          segments: [
            {
              color: edgeColorFor(firstChildItem || {}),
              path: trunkPath,
            },
            {
              color: edgeColorFor(firstChildItem),
              path: leftArmPath,
            },
            ...middleStemSegments,
            {
              color: edgeColorFor(itemForNode(rightChild.id, rightChild, itemById)),
              path: rightArmPath,
            },
          ],
        },
      },
    ];
  });
}

function samePosition(first, second) {
  return first?.x === second?.x && first?.y === second?.y;
}

function sameNodeData(first, second) {
  const a = first.data;
  const b = second.data;

  if (first.type === "separatorGuide" || second.type === "separatorGuide") {
    return a.height === b.height;
  }

  return (
    a.title === b.title &&
    a.description === b.description &&
    a.category === b.category &&
    a.type === b.type &&
    a.nodeType === b.nodeType &&
    a.docketState === b.docketState &&
    a.priority === b.priority &&
    a.parentId === b.parentId &&
    a.openQueue === b.openQueue &&
    a.assignee === b.assignee &&
    a.sprint === b.sprint &&
    a.storyPoints === b.storyPoints &&
    a.timeMinutes === b.timeMinutes &&
    a.calculatedStoryPoints === b.calculatedStoryPoints &&
    a.calculatedTimeMinutes === b.calculatedTimeMinutes &&
    a.dayWorklogCount === b.dayWorklogCount &&
    a.isDayRoot === b.isDayRoot &&
    a.isProjectNode === b.isProjectNode &&
    a.isSprintNode === b.isSprintNode &&
    a.allowChildActions === b.allowChildActions &&
    a.hiddenCount === b.hiddenCount &&
    a.hiddenRootCount === b.hiddenRootCount &&
    a.expandedSummaryId === b.expandedSummaryId &&
    a.searchMatch === b.searchMatch &&
    a.isCompletedSummary === b.isCompletedSummary &&
    JSON.stringify(a.completedSummaryControls || []) ===
      JSON.stringify(b.completedSummaryControls || []) &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    a.selected === b.selected &&
    a.isRoot === b.isRoot &&
    samePosition(a.position, b.position)
  );
}

function reconcileNodes(currentNodes, nextNodes) {
  if (currentNodes.length !== nextNodes.length) {
    return nextNodes;
  }

  let changed = false;
  const reconciled = nextNodes.map((nextNode, index) => {
    const currentNode = currentNodes[index];

    if (
      currentNode.id === nextNode.id &&
      currentNode.type === nextNode.type &&
      samePosition(currentNode.position, nextNode.position) &&
      sameNodeData(currentNode, nextNode)
    ) {
      return currentNode;
    }

    changed = true;
    return nextNode;
  });

  return changed ? reconciled : currentNodes;
}

function getNodeBounds(node) {
  const size = getNodeSize(node);

  return {
    left: node.position.x,
    right: node.position.x + size.width,
    top: node.position.y,
    bottom: node.position.y + size.height,
  };
}

function isWorkNode(node) {
  return node.type !== "separatorGuide";
}

function mergeBounds(bounds) {
  return bounds.reduce(
    (acc, bound) => ({
      left: Math.min(acc.left, bound.left),
      right: Math.max(acc.right, bound.right),
      top: Math.min(acc.top, bound.top),
      bottom: Math.max(acc.bottom, bound.bottom),
    }),
    {
      left: Infinity,
      right: -Infinity,
      top: Infinity,
      bottom: -Infinity,
    }
  );
}

function buildSeparatorGuides(nodes, workItems, rootNodeId, sprints = []) {
  const workNodes = nodes.filter(isWorkNode);
  const byId = new Map(workNodes.map((node) => [node.id, node]));
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const extraSprintIds = sprints
    .filter((sprint) => sprint.id !== ROOT_ID)
    .map((sprint) => sprint.id);
  const childrenByParent = workItems.reduce((acc, item) => {
    const parentId = visualParentIdForItem(
      item,
      byId.has(MAIN_ROOT_ID),
      sprints
    );

    if (!acc[parentId]) acc[parentId] = [];
    acc[parentId].push(item.id);
    return acc;
  }, {});

  if (byId.has(MAIN_ROOT_ID) && byId.has(ROOT_ID)) {
    childrenByParent[MAIN_ROOT_ID] = [ROOT_ID, ...extraSprintIds];
  }
  const subtreeBounds = new Map();

  function getSubtreeBounds(id) {
    if (subtreeBounds.has(id)) return subtreeBounds.get(id);

    const node = byId.get(id);
    const childIds = childrenByParent[id] || [];
    const bounds = node ? [getNodeBounds(node)] : [];

    childIds.forEach((childId) => {
      bounds.push(getSubtreeBounds(childId));
    });

    const merged = mergeBounds(bounds);
    subtreeBounds.set(id, merged);
    return merged;
  }

  getSubtreeBounds(rootNodeId);

  return Array.from(
    new Set([
      rootNodeId,
      ...(byId.has(MAIN_ROOT_ID) ? [ROOT_ID] : []),
      ...extraSprintIds,
      ...workItems.map((item) => item.id),
    ])
  ).flatMap(
    (parentId) => {
      const parentNode = byId.get(parentId);
      const parentType =
        parentId === MAIN_ROOT_ID
          ? "main-root"
          :
        parentId === ROOT_ID
          ? "story-root"
          : itemById.get(parentId)?.type;
      const childIds = childrenByParent[parentId] || [];

      if (
        !parentNode ||
        childIds.length < 2 ||
        !["main-root", "story-root", "epic"].includes(parentType)
      ) {
        return [];
      }

      const childBounds = childIds
        .map((childId) => ({
          id: childId,
          bounds: getSubtreeBounds(childId),
        }))
        .sort((first, second) => first.bounds.left - second.bounds.left);

      return childBounds.slice(0, -1).map((child, index) => {
        const nextChild = childBounds[index + 1];
        const x = (child.bounds.right + nextChild.bounds.left) / 2;
        const top =
          Math.min(child.bounds.top, nextChild.bounds.top) - 18;
        const bottom =
          Math.max(child.bounds.bottom, nextChild.bounds.bottom) + 16;

        return {
          id: `${parentId}-${child.id}-${nextChild.id}`,
          x,
          y: top,
          height: Math.max(24, bottom - top),
        };
      });
    }
  );
}

function withSeparatorGuideNodes(nodes, workItems, rootNodeId, sprints = []) {
  const workNodes = nodes.filter(isWorkNode);
  const guideNodes = buildSeparatorGuides(
    workNodes,
    workItems,
    rootNodeId,
    sprints
  ).map(
    (guide) => ({
      id: `separator:${guide.id}`,
      type: "separatorGuide",
      position: {
        x: guide.x,
        y: guide.y,
      },
      data: {
        height: guide.height,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
    })
  );

  return [...workNodes, ...guideNodes];
}

function workNodePositions(nodes) {
  return nodes.filter(isWorkNode).reduce((acc, node) => {
    acc[node.id] = node.position;
    return acc;
  }, {});
}

function displayDateForItem(item) {
  const primaryWorklog = Array.isArray(item.worklogs)
    ? item.worklogs[0]
    : null;

  return primaryWorklog?.date || item.updatedAt || item.createdAt;
}

function toFlowNodes({
  workItems,
  mainTitle,
  rootTitle,
  rootDocketState,
  sprints = [],
  storyPointTotals,
  viewRootId,
  viewMode,
  selectedId,
  existingPositions,
  actions,
  completedSummaryControls = new Map(),
  searchMatchIds = new Set(),
  daySummary,
  readOnly = false,
}) {
  const rootUpdatedAt = workItems.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || item.createdAt).getTime();
    const latestTime = new Date(latest || 0).getTime();

    return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
  }, "");

  const mainRootNode =
    (viewMode === "main" || viewMode === "sprint" || viewMode === "day") && !viewRootId
      ? [
          {
            id: MAIN_ROOT_ID,
            type: "jiraNode",
            position: existingPositions[MAIN_ROOT_ID] || {
              x: 0,
              y: 64,
            },
            data: {
              id: MAIN_ROOT_ID,
              title: mainTitle || "Genesis",
              type: "main-root",
              docketState: rootDocketState || "concept",
              updatedAt: rootUpdatedAt,
              position: existingPositions[MAIN_ROOT_ID] || {
                x: 0,
                y: 64,
              },
              calculatedStoryPoints: storyPointTotals.rootTotal,
              calculatedTimeMinutes: storyPointTotals.rootTimeMinutes,
              dayWorklogCount: daySummary?.worklogs || 0,
              nodeType: viewMode === "sprint" ? "sprint" : "project",
              isDayRoot: viewMode === "day",
              selected: selectedId === MAIN_ROOT_ID,
              isRoot: true,
              isVirtual: true,
              isProjectNode: viewMode === "main",
              isSprintNode: viewMode === "sprint",
              allowChildActions: !readOnly && viewMode !== "day",
              completedSummaryControls:
                completedSummaryControls.get(MAIN_ROOT_ID) || [],
              ...actions,
            },
          },
        ]
      : [];
  const rootNode = viewRootId
    ? []
    : [
        {
          id: ROOT_ID,
          type: "jiraNode",
          position: existingPositions[ROOT_ID] || {
            x: 0,
            y: 64,
          },
          data: {
            id: ROOT_ID,
            title: rootTitle,
            type: "story-root",
            docketState: rootDocketState || "concept",
            updatedAt: rootUpdatedAt,
            position: existingPositions[ROOT_ID] || {
              x: 0,
              y: 64,
            },
            calculatedStoryPoints: storyPointTotals.rootTotal,
            calculatedTimeMinutes: storyPointTotals.rootTimeMinutes,
            nodeType: "project",
            selected: selectedId === ROOT_ID,
            isRoot: true,
            isProjectNode: true,
            allowChildActions: !readOnly,
            completedSummaryControls:
              completedSummaryControls.get(ROOT_ID) || [],
            ...actions,
          },
        },
      ];
  const extraSprintNodes =
    (viewMode === "main" || viewMode === "day") && !viewRootId
      ? sprints
          .filter((sprint) => sprint.id !== ROOT_ID)
          .map((sprint) => ({
            id: sprint.id,
            type: "jiraNode",
            position: existingPositions[sprint.id] || {
              x: 0,
              y: 64,
            },
            data: {
              id: sprint.id,
              title: sprint.title,
              type: "story-root",
              docketState: sprint.docketState || "concept",
              updatedAt: rootUpdatedAt,
              position: existingPositions[sprint.id] || {
                x: 0,
                y: 64,
              },
              calculatedStoryPoints: 0,
              calculatedTimeMinutes:
                storyPointTotals.sprintTimeById?.[sprint.id] ??
                storyPointTotals.sprintTimeByTitle?.[sprint.title] ??
                0,
              selected: selectedId === sprint.id,
              isRoot: true,
              isVirtual: true,
              isSprintNode: true,
              allowChildActions: !readOnly,
              childParentId: sprint.id,
              completedSummaryControls:
                completedSummaryControls.get(sprint.id) || [],
              ...actions,
            },
          }))
      : [];

  const baseNodes = [
    ...mainRootNode,
    ...rootNode,
    ...extraSprintNodes,
    ...workItems.map((item) => {
      return {
        id: item.id,
        type: "jiraNode",
        position: existingPositions[item.id] || {
          x: 0,
          y: 64,
        },
        data: {
          ...item,
          updatedAt: displayDateForItem(item),
          position: existingPositions[item.id] || {
            x: 0,
            y: 64,
          },
          selected: selectedId === (item.sourceId || item.id),
          calculatedStoryPoints: storyPointTotals.byId[item.id],
          calculatedTimeMinutes: item.isCompletedSummary
            ? item.hiddenTimeMinutes
            : storyPointTotals.timeById[item.id],
          hiddenCount: item.hiddenCount,
          hiddenRootCount: item.hiddenRootCount,
          hiddenChildIds: item.hiddenChildIds,
          expandedSummaryId: item.expandedSummaryId,
          summaryType: item.summaryType,
          isCompletedSummary: item.isCompletedSummary,
          isVirtual: item.isVirtual,
          searchMatch: searchMatchIds.has(item.sourceId || item.id),
          completedSummaryControls:
            completedSummaryControls.get(item.id) || [],
          allowChildActions: !readOnly,
          ...actions,
        },
      };
    }),
  ];

  return baseNodes;
}

export default function GraphView({
  workItems,
  mainTitle,
  rootTitle,
  rootDocketState,
  sprints = [],
  storyPointTotals,
  viewRootId,
  viewMode,
  selectedId,
  onSelect,
  onOpenDetails,
  onStartChild,
  onStartSprint,
  layoutNonce,
  searchQuery = "",
  daySummary,
  readOnly = false,
}) {
  const reactFlowRef = useRef(null);
  const initialViewCenteredRef = useRef(false);
  const focusedSearchRef = useRef("");
  const [canvasLocked, setCanvasLocked] = useState(false);
  const [expandedSummaryIds, setExpandedSummaryIds] = useState(
    loadExpandedSummaryIds
  );
  const showMainRoot =
    (viewMode === "main" || viewMode === "sprint" || viewMode === "day") &&
    !viewRootId;
  const rootNodeId = viewRootId || (showMainRoot ? MAIN_ROOT_ID : ROOT_ID);
  const appliedLayoutKeyRef = useRef("");
  const collapsedGraph = useMemo(
    () =>
      prepareCompletedCollapse({
        workItems,
        expandedSummaryIds,
        searchQuery,
        storyPointTotals,
      }),
    [expandedSummaryIds, searchQuery, storyPointTotals, workItems]
  );
  const renderedWorkItems = collapsedGraph.workItems;
  const completedSummaryControls = collapsedGraph.summaryControlsByParent;
  const searchMatchIds = collapsedGraph.searchMatchIds;
  const availableSummaryIds = collapsedGraph.summaryIds;
  const layoutStructureKey = useMemo(
    () =>
      JSON.stringify({
        layoutNonce,
        rootNodeId,
        viewMode,
        sprints: sprints.map((sprint) => [
          sprint.id,
          sprint.title,
          sprint.docketState,
        ]),
        workItems: renderedWorkItems.map((item) => [
          item.id,
          item.parentId,
          item.type,
          item.hiddenCount,
        ]),
      }),
    [layoutNonce, rootNodeId, viewMode, sprints, renderedWorkItems]
  );
  const actions = useMemo(
    () => ({
      onStartChild,
      onStartSprint,
      onToggleCompletedSummary: (summaryId) => {
        setExpandedSummaryIds((current) => {
          const next = new Set(current);

          if (next.has(summaryId)) {
            next.delete(summaryId);
          } else {
            next.add(summaryId);
          }

          saveExpandedSummaryIds(next);
          return next;
        });
      },
    }),
    [onStartChild, onStartSprint]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState([]);

  useLayoutEffect(() => {
    setExpandedSummaryIds((current) => {
      const next = new Set(
        Array.from(current).filter((summaryId) =>
          availableSummaryIds.has(summaryId)
        )
      );

      if (next.size === current.size) return current;

      saveExpandedSummaryIds(next);
      return next;
    });
  }, [availableSummaryIds]);
  const connectorEdges = useMemo(
    () =>
      buildBranchConnectorEdges(
        nodes,
        renderedWorkItems,
        !viewRootId,
        rootNodeId,
        sprints
      ),
    [nodes, rootNodeId, viewRootId, sprints, renderedWorkItems]
  );

  const centerInitialViewOnRoot = useCallback(
    (currentNodes) => {
      if (initialViewCenteredRef.current || !reactFlowRef.current) {
        return;
      }

      const rootNode = currentNodes.find((node) => node.id === rootNodeId);

      if (!rootNode?.position) return;

      const rootSize = getNodeSize(rootNode);
      const rootCenterX = rootNode.position.x + rootSize.width / 2;
      const zoom = 1;

      initialViewCenteredRef.current = true;

      window.requestAnimationFrame(() => {
        const wrapper = document.querySelector(".graph-view");
        const width = wrapper?.clientWidth || window.innerWidth;
        const topPadding =
          viewMode === "day" ? (width < 760 ? 220 : 158) : 96;

        reactFlowRef.current?.setViewport(
          {
            x: width / 2 - rootCenterX * zoom,
            y: topPadding - rootNode.position.y * zoom,
            zoom,
          },
          {
            duration: 0,
          }
        );
      });
    },
    [rootNodeId, viewMode]
  );

  useLayoutEffect(() => {
    initialViewCenteredRef.current = false;
  }, [rootNodeId, viewMode]);

  useLayoutEffect(() => {
    setNodes((currentNodes) => {
      const existingPositions = workNodePositions(currentNodes);

      const nextNodes = withSeparatorGuideNodes(toFlowNodes({
        workItems: renderedWorkItems,
        mainTitle,
        rootTitle,
        rootDocketState,
        sprints,
        storyPointTotals,
        viewRootId,
        viewMode,
        selectedId,
        existingPositions,
        actions,
        completedSummaryControls,
        searchMatchIds,
        daySummary,
        readOnly,
      }), renderedWorkItems, rootNodeId, sprints);

      return reconcileNodes(currentNodes, nextNodes);
    });
  }, [
    actions,
    rootDocketState,
    mainTitle,
    rootTitle,
    rootNodeId,
    sprints,
    selectedId,
    setNodes,
    storyPointTotals,
    completedSummaryControls,
    searchMatchIds,
    daySummary,
    readOnly,
    viewRootId,
    viewMode,
    renderedWorkItems,
  ]);

  useLayoutEffect(() => {
    if (
      layoutNonce === 0 ||
      appliedLayoutKeyRef.current === layoutStructureKey
    ) {
      return;
    }

    appliedLayoutKeyRef.current = layoutStructureKey;

    setNodes((currentNodes) => {
      const existingPositions = workNodePositions(currentNodes);
      const measuredById = new Map(
        currentNodes.filter(isWorkNode).map((node) => [node.id, node])
      );
      const baseNodes = toFlowNodes({
        workItems: renderedWorkItems,
        mainTitle,
        rootTitle,
        rootDocketState,
        sprints,
        storyPointTotals,
        viewRootId,
        viewMode,
        selectedId,
        existingPositions,
        actions,
        completedSummaryControls,
        searchMatchIds,
        daySummary,
        readOnly,
      }).map((node) => {
        const measured = measuredById.get(node.id);

        return measured
          ? {
              ...node,
              measured: measured.measured,
              width: measured.width,
              height: measured.height,
            }
          : node;
      });
      const layout = getLayoutedElements(
        baseNodes,
        buildLayoutEdges(renderedWorkItems, !viewRootId, showMainRoot, sprints),
        rootNodeId
      );
      const nextNodes = withSeparatorGuideNodes(layout.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          position: node.position,
        },
      })), renderedWorkItems, rootNodeId, sprints);
      const reconciledNodes = reconcileNodes(
        currentNodes,
        nextNodes
      );

      return reconciledNodes;
    });
  }, [
    actions,
    layoutStructureKey,
    layoutNonce,
    rootDocketState,
    mainTitle,
    rootTitle,
    rootNodeId,
    sprints,
    selectedId,
    setNodes,
    storyPointTotals,
    completedSummaryControls,
    searchMatchIds,
    daySummary,
    readOnly,
    viewRootId,
    viewMode,
    showMainRoot,
    renderedWorkItems,
  ]);

  useLayoutEffect(() => {
    centerInitialViewOnRoot(nodes);
  }, [centerInitialViewOnRoot, nodes]);

  useLayoutEffect(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();

    if (!normalizedSearch || !reactFlowRef.current) {
      focusedSearchRef.current = "";
      return;
    }

    const match = nodes.find(
      (node) => isWorkNode(node) && node.data?.searchMatch
    );

    if (!match?.position || focusedSearchRef.current === `${normalizedSearch}:${match.id}`) {
      return;
    }

    focusedSearchRef.current = `${normalizedSearch}:${match.id}`;

    const size = getNodeSize(match);
    reactFlowRef.current.setCenter(
      match.position.x + size.width / 2,
      match.position.y + size.height / 2,
      {
        zoom: 1.05,
        duration: 240,
      }
    );
  }, [nodes, searchQuery]);

  const handleNodeClick = useCallback(
    (_event, node) => {
      onSelect(node.data?.sourceId || node.id);
    },
    [onSelect]
  );

  const handleNodeDoubleClick = useCallback(
    (event, node) => {
      event.preventDefault();
      event.stopPropagation();
      if (node.data?.isVirtual) return;
      onOpenDetails(node.data?.sourceId || node.id);
    },
    [onOpenDetails]
  );

  const handlePaneClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  const handleFitView = useCallback(() => {
    reactFlowRef.current?.fitView({
      padding: 0.18,
      duration: 180,
    });
  }, []);

  const handleFullscreen = useCallback(() => {
    const element = document.querySelector(".app-container");

    if (!document.fullscreenElement) {
      element?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  return (
    <div className="graph-view">
      <ReactFlow
        nodes={nodes}
        edges={connectorEdges}
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={handlePaneClick}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnDrag={!canvasLocked}
        zoomOnScroll={!canvasLocked}
        zoomOnPinch={!canvasLocked}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        minZoom={0.25}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          reactFlowRef.current = instance;
          centerInitialViewOnRoot(nodes);
        }}
      >
        <Background color="rgba(148, 163, 184, 0.16)" gap={24} size={1} />
      </ReactFlow>
      <div className="canvas-controls" aria-label="Canvas controls">
        <button
          type="button"
          onClick={() => reactFlowRef.current?.zoomIn({ duration: 150 })}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => reactFlowRef.current?.zoomOut({ duration: 150 })}
          aria-label="Zoom out"
          title="Zoom out"
        >
          -
        </button>
        <button
          type="button"
          onClick={handleFitView}
          aria-label="Fit view"
          title="Fit view"
        >
          Fit
        </button>
        <button
          type="button"
          onClick={() => setCanvasLocked((locked) => !locked)}
          aria-pressed={canvasLocked}
          aria-label="Lock canvas"
          title="Lock canvas"
        >
          {canvasLocked ? "Locked" : "Lock"}
        </button>
        <button
          type="button"
          onClick={handleFullscreen}
          aria-label="Fullscreen"
          title="Fullscreen"
        >
          Full
        </button>
      </div>
    </div>
  );
}
