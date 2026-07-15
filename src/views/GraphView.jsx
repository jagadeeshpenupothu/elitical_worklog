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
  if (item.type !== "story" && item.type !== "job") {
    return item.updatedAt || item.createdAt;
  }

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
}) {
  const rootUpdatedAt = workItems.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || item.createdAt).getTime();
    const latestTime = new Date(latest || 0).getTime();

    return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
  }, "");

  const mainRootNode =
    viewMode === "main" && !viewRootId
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
              selected: false,
              isRoot: true,
              isVirtual: true,
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
            selected: selectedId === ROOT_ID,
            isRoot: true,
            ...actions,
          },
        },
      ];
  const extraSprintNodes =
    viewMode === "main" && !viewRootId
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
              calculatedTimeMinutes: 0,
              selected: false,
              isRoot: true,
              isVirtual: true,
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
          selected: selectedId === item.id,
          calculatedStoryPoints: storyPointTotals.byId[item.id],
          calculatedTimeMinutes: storyPointTotals.timeById[item.id],
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
}) {
  const reactFlowRef = useRef(null);
  const initialViewCenteredRef = useRef(false);
  const [canvasLocked, setCanvasLocked] = useState(false);
  const showMainRoot = viewMode === "main" && !viewRootId;
  const rootNodeId = viewRootId || (showMainRoot ? MAIN_ROOT_ID : ROOT_ID);
  const appliedLayoutKeyRef = useRef("");
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
        workItems: workItems.map((item) => [
          item.id,
          item.parentId,
          item.type,
        ]),
      }),
    [layoutNonce, rootNodeId, viewMode, sprints, workItems]
  );
  const actions = useMemo(
    () => ({
      onStartChild,
      onStartSprint,
    }),
    [onStartChild, onStartSprint]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const connectorEdges = useMemo(
    () =>
      buildBranchConnectorEdges(
        nodes,
        workItems,
        !viewRootId,
        rootNodeId,
        sprints
      ),
    [nodes, rootNodeId, viewRootId, sprints, workItems]
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
      const topPadding = 96;
      const zoom = 1;

      initialViewCenteredRef.current = true;

      window.requestAnimationFrame(() => {
        const wrapper = document.querySelector(".graph-view");
        const width = wrapper?.clientWidth || window.innerWidth;

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
    [rootNodeId]
  );

  useLayoutEffect(() => {
    initialViewCenteredRef.current = false;
  }, [rootNodeId]);

  useLayoutEffect(() => {
    setNodes((currentNodes) => {
      const existingPositions = workNodePositions(currentNodes);

      const nextNodes = withSeparatorGuideNodes(toFlowNodes({
        workItems,
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
      }), workItems, rootNodeId, sprints);

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
    viewRootId,
    viewMode,
    workItems,
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
        workItems,
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
        buildLayoutEdges(workItems, !viewRootId, showMainRoot, sprints),
        rootNodeId
      );
      const nextNodes = withSeparatorGuideNodes(layout.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          position: node.position,
        },
      })), workItems, rootNodeId, sprints);
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
    viewRootId,
    viewMode,
    showMainRoot,
    workItems,
  ]);

  useLayoutEffect(() => {
    centerInitialViewOnRoot(nodes);
  }, [centerInitialViewOnRoot, nodes]);

  const handleNodeClick = useCallback(
    (_event, node) => {
      onSelect(node.id);
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
