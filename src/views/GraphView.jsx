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
import {
  buildProjectedHierarchy,
  isReferenceNode,
  isOrphanSprintScope,
} from "../utils/hierarchyProjection";
import { canCreateChildForNode } from "../utils/nodeCapabilities";
import { ROOT_ID } from "../utils/worklogModel";
import {
  docketStateCssClass,
  normalizeDocketState,
} from "../utils/docketStates";

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

function isCompletedItem(item) {
  if (item?.isGhost) return false;

  return COMPLETED_STATES.has(normalizeDocketState(item?.docketState || item?.status));
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
  searchMatchIds = new Set(),
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
  function isCompletedBranch(item) {
    if (branchCompletion.has(item.id)) return branchCompletion.get(item.id);

    const complete =
      isCompletedItem(item) &&
      (childrenByParent.get(item.id) || []).every(isCompletedBranch);

    branchCompletion.set(item.id, complete);
    return complete;
  }

  function branchContainsSearch(item) {
    if (!searchMatchIds.size) return false;
    if (searchMatchIds.has(item.sourceItemId || item.sourceDocketId || item.sourceId || item.id)) return true;

    return descendantIdsFor(item.id, childrenByParent).some((id) =>
      searchMatchIds.has(id)
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
    searchMatchIds,
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
  "in-review": "#F97316",
  closed: "#1E3A8A",
};

function edgeColorFor(item) {
  return DOCKET_STATE_COLORS[docketStateCssClass(item.docketState)] || DOCKET_STATE_COLORS.concept;
}

function itemForNode(id, node, itemById) {
  if (id === ROOT_ID || id === MAIN_ROOT_ID) {
    return node?.data || {};
  }

  return itemById.get(id) || {};
}

function visualParentIdForItem(item, includeMainRoot, sprints = []) {
  if (item.visualParentId) return item.visualParentId;
  if (!includeMainRoot || item.parentId !== ROOT_ID) return item.parentId;

  const sprint = sprints.find(
    (entry) =>
      entry.id !== ROOT_ID &&
      (entry.id === (item.elitical?.sprintId || item.sprintId) ||
        entry.title === item.sprint)
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
  sprints = [],
  routeRootItemsThroughSprint = includeMainRoot
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
      const source = visualParentIdForItem(
        item,
        routeRootItemsThroughSprint,
        sprints
      );

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
          id: `${ROOT_ID}-${id}`,
          source: ROOT_ID,
          target: id,
        })),
        ...workEdges,
      ]
    : [
        ...extraSprintIds.map((id) => ({
          id: `${ROOT_ID}-${id}`,
          source: ROOT_ID,
          target: id,
        })),
        ...workEdges,
      ];
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
    childrenByParent[MAIN_ROOT_ID] = [ROOT_ID];
  }

  if (includeRootNode && nodeById.has(ROOT_ID) && extraSprintIds.length > 0) {
    childrenByParent[ROOT_ID] = [
      ...new Set([...(childrenByParent[ROOT_ID] || []), ...extraSprintIds]),
    ];
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
    a.dayContextDate === b.dayContextDate &&
    a.isDayProjectionSelected === b.isDayProjectionSelected &&
    a.isRetainedDayContext === b.isRetainedDayContext &&
    a.isDayRoot === b.isDayRoot &&
    a.isProjectNode === b.isProjectNode &&
    a.isSprintNode === b.isSprintNode &&
    a.isReference === b.isReference &&
    a.isGhost === b.isGhost &&
    a.sourceItemId === b.sourceItemId &&
    a.targetScopeId === b.targetScopeId &&
    a.targetSprintId === b.targetSprintId &&
    a.allowChildActions === b.allowChildActions &&
    a.childParentId === b.childParentId &&
    a.childSprintId === b.childSprintId &&
    a.childSprint === b.childSprint &&
    JSON.stringify(a.childActionItems || []) ===
      JSON.stringify(b.childActionItems || []) &&
    a.hiddenCount === b.hiddenCount &&
    a.hiddenRootCount === b.hiddenRootCount &&
    a.expandedSummaryId === b.expandedSummaryId &&
    a.searchMatch === b.searchMatch &&
    a.searchActive === b.searchActive &&
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

function getNodeCenter(node) {
  const size = getNodeSize(node);

  return {
    x: node.position.x + size.width / 2,
    y: node.position.y + size.height / 2,
  };
}

function usableGraphCenter(wrapper) {
  const graphRect = wrapper?.getBoundingClientRect?.();

  if (!graphRect) {
    return {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
  }

  const toolbarRect = document
    .querySelector(".top-toolbar")
    ?.getBoundingClientRect?.();
  const coveredTop =
    toolbarRect && toolbarRect.bottom > graphRect.top
      ? Math.min(graphRect.height, toolbarRect.bottom - graphRect.top)
      : 0;
  const usableHeight = Math.max(1, graphRect.height - coveredTop);

  return {
    x: graphRect.width / 2,
    y: coveredTop + usableHeight / 2,
  };
}

function isWorkNode(node) {
  return node.type !== "separatorGuide";
}

function canonicalDocketNodeId(node) {
  const data = node?.data || {};
  const type = String(data.type || "").toLowerCase();

  if (!["epic", "story", "task", "job"].includes(type)) return "";
  if (data.isCompletedSummary) return "";

  return data.sourceItemId || data.sourceDocketId || data.sourceId || data.id || node.id || "";
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
    childrenByParent[MAIN_ROOT_ID] = [ROOT_ID];
  }

  if (byId.has(ROOT_ID) && extraSprintIds.length > 0) {
    childrenByParent[ROOT_ID] = [
      ...new Set([...(childrenByParent[ROOT_ID] || []), ...extraSprintIds]),
    ];
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

  return (
    primaryWorklog?.date ||
    item.primaryWorklogDate ||
    item.worklogDate ||
    item.updatedAt ||
    item.createdAt
  );
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
  childActionItemsForNode,
  completedSummaryControls = new Map(),
  searchMatchIds = new Set(),
  activeSearchId = "",
  daySummary,
  readOnly = false,
}) {
  const rootUpdatedAt = workItems.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || item.createdAt).getTime();
    const latestTime = new Date(latest || 0).getTime();

    return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
  }, "");

  const showScopeRoot = viewMode === "day";
  const mainRootNode =
    showScopeRoot && !viewRootId
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
              searchMatch: searchMatchIds.has(MAIN_ROOT_ID),
              searchActive: activeSearchId === MAIN_ROOT_ID,
              isRoot: true,
              isVirtual: true,
              isProjectNode: viewMode === "main",
              isSprintNode: false,
              allowChildActions: false,
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
            searchMatch: searchMatchIds.has(ROOT_ID),
            searchActive: activeSearchId === ROOT_ID,
            isRoot: true,
            isProjectNode: true,
            allowChildActions: false,
            completedSummaryControls:
              completedSummaryControls.get(ROOT_ID) || [],
            ...actions,
          },
        },
      ];
  const extraSprintNodes =
    !viewRootId
      ? sprints
          .filter((sprint) => sprint.id !== ROOT_ID)
          .map((sprint) => {
            const isOrphanSprint = isOrphanSprintScope(sprint);
            const childActionItems = childActionItemsForNode?.(sprint) || [];

            return {
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
                calculatedStoryPoints:
                  storyPointTotals.sprintStoryPointsById?.[sprint.id] ??
                  storyPointTotals.sprintStoryPointsByTitle?.[sprint.title] ??
                  0,
                calculatedTimeMinutes:
                  storyPointTotals.sprintTimeById?.[sprint.id] ??
                  storyPointTotals.sprintTimeByTitle?.[sprint.title] ??
                  0,
                selected: selectedId === sprint.id,
                searchMatch: searchMatchIds.has(sprint.id),
                searchActive: activeSearchId === sprint.id,
                isRoot: true,
                isVirtual: true,
                isSprintNode: true,
                isOrphanSprint,
                allowChildActions:
                  !readOnly && (isOrphanSprint || childActionItems.length > 0),
                childParentId: isOrphanSprint ? ROOT_ID : sprint.id,
                childSprintId: isOrphanSprint ? "" : sprint.id,
                childSprint: sprint.title,
                childActionItems,
                completedSummaryControls:
                  completedSummaryControls.get(sprint.id) || [],
                ...actions,
              },
            };
          })
      : [];

  const baseNodes = [
    ...mainRootNode,
    ...rootNode,
    ...extraSprintNodes,
    ...workItems.map((item) => {
      const isGhost = isReferenceNode(item);
      const metricId = item.id;
      const childActionItems = childActionItemsForNode?.(item) || [];

      return {
        id: item.id,
        type: "jiraNode",
        position: existingPositions[item.id] || {
          x: 0,
          y: 64,
        },
        draggable: !isGhost,
        selectable: !isGhost,
        deletable: !isGhost,
        data: {
          ...item,
          updatedAt: displayDateForItem(item),
          position: existingPositions[item.id] || {
            x: 0,
            y: 64,
          },
          selected: selectedId === (item.sourceId || item.id),
          calculatedStoryPoints: storyPointTotals.byId[metricId],
          calculatedTimeMinutes: item.isCompletedSummary
            ? item.hiddenTimeMinutes
            : storyPointTotals.timeById[metricId],
          hiddenCount: item.hiddenCount,
          hiddenRootCount: item.hiddenRootCount,
          hiddenChildIds: item.hiddenChildIds,
          expandedSummaryId: item.expandedSummaryId,
          summaryType: item.summaryType,
          isCompletedSummary: item.isCompletedSummary,
          isVirtual: item.isVirtual,
          searchMatch: searchMatchIds.has(item.sourceItemId || item.sourceDocketId || item.sourceId || item.id),
          searchActive:
            activeSearchId &&
            activeSearchId === (item.sourceItemId || item.sourceDocketId || item.sourceId || item.id),
          completedSummaryControls:
            completedSummaryControls.get(item.id) || [],
          childActionItems,
          allowChildActions:
            !readOnly &&
            item.allowChildActions !== false &&
            (canCreateChildForNode(item) || childActionItems.length > 0),
          ...actions,
        },
      };
    }),
  ];

  return baseNodes;
}

export default function GraphView({
  workItems,
  allWorkItems = workItems,
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
  onAddExistingChild,
  childActionItemsForNode,
  layoutNonce,
  searchMatchIds: externalSearchMatchIds = new Set(),
  activeSearchId = "",
  activeSearchNodeId = "",
  activeSearchFocusKey = "",
  daySummary,
  projectHierarchy = true,
  canvasFullMode = false,
  onCanvasFullModeChange,
  readOnly = false,
}) {
  const reactFlowRef = useRef(null);
  const graphViewRef = useRef(null);
  const initialViewCenteredRef = useRef(false);
  const focusedSearchRef = useRef("");
  const [canvasLocked, setCanvasLocked] = useState(false);
  const [expandedSummaryIds, setExpandedSummaryIds] = useState(
    loadExpandedSummaryIds
  );
  const showMainRoot = viewMode === "day" && !viewRootId;
  const routeRootItemsThroughSprint = !viewRootId && sprints.length > 0;
  const rootNodeId = viewRootId || (showMainRoot ? MAIN_ROOT_ID : ROOT_ID);
  const appliedLayoutKeyRef = useRef("");
  const collapsedGraph = useMemo(
    () =>
      prepareCompletedCollapse({
        workItems: projectHierarchy
          ? buildProjectedHierarchy({
              items: workItems,
              allItems: allWorkItems,
              scopes: sprints,
              enabled: true,
            }).items
          : workItems,
        expandedSummaryIds,
        searchMatchIds: externalSearchMatchIds,
        storyPointTotals,
      }),
    [
      allWorkItems,
      expandedSummaryIds,
      externalSearchMatchIds,
      sprints,
      storyPointTotals,
      workItems,
      projectHierarchy,
    ]
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
          item.visualParentId,
          item.type,
          item.isReference,
          item.isGhost,
          item.sourceItemId,
          item.targetScopeId,
          item.targetSprintId,
          item.hiddenCount,
        ]),
      }),
    [layoutNonce, rootNodeId, viewMode, sprints, renderedWorkItems]
  );
  const actions = useMemo(
    () => ({
      onStartChild,
      onStartSprint,
      onAddExistingChild,
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
    [onAddExistingChild, onStartChild, onStartSprint]
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
      if (activeSearchId || initialViewCenteredRef.current || !reactFlowRef.current) {
        return;
      }

      const rootNode = currentNodes.find((node) => node.id === rootNodeId);

      if (!rootNode?.position) return;

      const rootSize = getNodeSize(rootNode);
      const rootCenterX = rootNode.position.x + rootSize.width / 2;
      const zoom = 1;

      initialViewCenteredRef.current = true;

      window.requestAnimationFrame(() => {
        const wrapper = graphViewRef.current;
        const width = wrapper?.clientWidth || window.innerWidth;
        const topPadding = width < 760 ? 56 : 42;

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
    [activeSearchId, rootNodeId, viewMode]
  );

  useLayoutEffect(() => {
    initialViewCenteredRef.current = false;
  }, [rootNodeId, viewMode]);

  useLayoutEffect(() => {
    setNodes((currentNodes) => {
      if (appliedLayoutKeyRef.current !== layoutStructureKey) {
        return currentNodes;
      }

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
        childActionItemsForNode,
        completedSummaryControls,
        searchMatchIds,
        activeSearchId,
        daySummary,
        readOnly,
      }), renderedWorkItems, rootNodeId, sprints);

      return reconcileNodes(currentNodes, nextNodes);
    });
  }, [
    actions,
    childActionItemsForNode,
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
    activeSearchId,
    daySummary,
    layoutStructureKey,
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
    const viewportBeforeLayout =
      !activeSearchId && initialViewCenteredRef.current
        ? reactFlowRef.current?.getViewport?.()
        : null;

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
        childActionItemsForNode,
        completedSummaryControls,
        searchMatchIds,
        activeSearchId,
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
        buildLayoutEdges(
          renderedWorkItems,
          !viewRootId,
          showMainRoot,
          sprints,
          routeRootItemsThroughSprint
        ),
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

    if (viewportBeforeLayout) {
      const restoreViewportFrame = window.requestAnimationFrame(() => {
        reactFlowRef.current?.setViewport?.(viewportBeforeLayout, {
          duration: 0,
        });
      });

      return () => {
        window.cancelAnimationFrame(restoreViewportFrame);
      };
    }
  }, [
    actions,
    childActionItemsForNode,
    layoutStructureKey,
    layoutNonce,
    rootDocketState,
    mainTitle,
    rootTitle,
    rootNodeId,
    routeRootItemsThroughSprint,
    sprints,
    selectedId,
    setNodes,
    storyPointTotals,
    completedSummaryControls,
    searchMatchIds,
    activeSearchId,
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
    if (!activeSearchId || !reactFlowRef.current) {
      focusedSearchRef.current = "";
      return;
    }

    const match =
      nodes.find((node) => isWorkNode(node) && node.id === activeSearchNodeId) ||
      nodes.find((node) => isWorkNode(node) && node.data?.searchActive);

    if (!match?.position) {
      return;
    }

    const size = getNodeSize(match);
    const viewport = reactFlowRef.current.getViewport?.() || {
      zoom: reactFlowRef.current.getZoom?.() || 1,
    };
    const focusKey = [
      activeSearchId,
      activeSearchNodeId,
      activeSearchFocusKey,
      match.id,
      match.position.x,
      match.position.y,
      size.width,
      size.height,
      viewport.zoom,
    ].join(":");

    if (focusedSearchRef.current === focusKey) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const instance = reactFlowRef.current;

      if (!instance) return;

      const latestViewport = instance.getViewport?.() || viewport;
      const zoom = Number.isFinite(latestViewport.zoom)
        ? latestViewport.zoom
        : 1;
      const nodeCenter = getNodeCenter(match);
      const graphCenter = usableGraphCenter(graphViewRef.current);

      instance.setViewport(
        {
          x: graphCenter.x - nodeCenter.x * zoom,
          y: graphCenter.y - nodeCenter.y * zoom,
          zoom,
        },
        {
          duration: 260,
        }
      );
      focusedSearchRef.current = focusKey;
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [activeSearchFocusKey, activeSearchId, activeSearchNodeId, nodes]);

  const handleNodeClick = useCallback(
    (event, node) => {
      const canonicalId = canonicalDocketNodeId(node);

      if (canonicalId) {
        event.preventDefault();
        onOpenDetails(canonicalId);
        return;
      }

      onSelect(node.data?.sourceItemId || node.data?.sourceDocketId || node.data?.sourceId || node.id);
    },
    [onOpenDetails, onSelect]
  );

  const handleNodeDoubleClick = useCallback(
    (event, node) => {
      event.preventDefault();
      event.stopPropagation();
      const canonicalId = canonicalDocketNodeId(node);

      if (canonicalId) onOpenDetails(canonicalId);
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
    onCanvasFullModeChange?.(!canvasFullMode);
  }, [canvasFullMode, onCanvasFullModeChange]);

  return (
    <div className="graph-view" ref={graphViewRef}>
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
          aria-pressed={canvasFullMode}
          aria-label={canvasFullMode ? "Exit full canvas" : "Full canvas"}
          title={canvasFullMode ? "Exit full canvas" : "Full canvas"}
        >
          Full
        </button>
      </div>
    </div>
  );
}
