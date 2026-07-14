import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import ReactFlow, {
  Background,
  Controls,
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
  concept: "#20d989",
  design: "#0a73d9",
  review: "#ff9f0a",
  closed: "#7c3aed",
  artifact: "#8b949e",
};

function edgeColorFor(item) {
  return DOCKET_STATE_COLORS[item.docketState || "concept"];
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

function buildLayoutEdges(workItems, includeRootNode) {
  const visibleIds = new Set(workItems.map((item) => item.id));
  return workItems
    .filter(
      (item) =>
        visibleIds.has(item.parentId) ||
        (includeRootNode && item.parentId === ROOT_ID)
    )
    .map((item) => ({
      id: `${item.parentId}-${item.id}`,
      source: item.parentId,
      target: item.id,
    }));
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

function buildBranchConnectorEdges(nodes, workItems, includeRootNode, rootNodeId) {
  const workNodes = nodes.filter(isWorkNode);
  const nodeById = new Map(workNodes.map((node) => [node.id, node]));
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const visibleIds = new Set(workItems.map((item) => item.id));
  const childrenByParent = workItems.reduce((acc, item) => {
    if (
      visibleIds.has(item.parentId) ||
      (includeRootNode && item.parentId === ROOT_ID)
    ) {
      if (!acc[item.parentId]) acc[item.parentId] = [];
      acc[item.parentId].push(item.id);
    }

    return acc;
  }, {});

  return Array.from(
    new Set([rootNodeId, ...workItems.map((item) => item.parentId)])
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
      const childItem = itemById.get(child.id);

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
        color: edgeColorFor(itemById.get(child.id) || {}),
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
    const parentItem = itemById.get(parentId);

    return [
      {
        id: `branch:${parentId}`,
        source: parentId,
        target: children[0].id,
        type: "parentBranch",
        data: {
          segments: [
            {
              color: edgeColorFor(parentItem || {}),
              path: trunkPath,
            },
            {
              color: edgeColorFor(itemById.get(leftChild.id) || {}),
              path: leftArmPath,
            },
            ...middleStemSegments,
            {
              color: edgeColorFor(itemById.get(rightChild.id) || {}),
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

function buildSeparatorGuides(nodes, workItems, rootNodeId) {
  const workNodes = nodes.filter(isWorkNode);
  const byId = new Map(workNodes.map((node) => [node.id, node]));
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const childrenByParent = workItems.reduce((acc, item) => {
    if (!acc[item.parentId]) acc[item.parentId] = [];
    acc[item.parentId].push(item.id);
    return acc;
  }, {});
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
    new Set([rootNodeId, ...workItems.map((item) => item.id)])
  ).flatMap(
    (parentId) => {
      const parentNode = byId.get(parentId);
      const parentType =
        parentId === ROOT_ID
          ? "story-root"
          : itemById.get(parentId)?.type;
      const childIds = childrenByParent[parentId] || [];

      if (
        !parentNode ||
        childIds.length < 2 ||
        !["story-root", "epic"].includes(parentType)
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

function withSeparatorGuideNodes(nodes, workItems, rootNodeId) {
  const workNodes = nodes.filter(isWorkNode);
  const guideNodes = buildSeparatorGuides(
    workNodes,
    workItems,
    rootNodeId
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
  rootTitle,
  rootDocketState,
  storyPointTotals,
  viewRootId,
  selectedId,
  existingPositions,
  actions,
}) {
  const rootUpdatedAt = workItems.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || item.createdAt).getTime();
    const latestTime = new Date(latest || 0).getTime();

    return itemTime > latestTime ? item.updatedAt || item.createdAt : latest;
  }, "");

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

  const baseNodes = [
    ...rootNode,
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
  rootTitle,
  rootDocketState,
  storyPointTotals,
  viewRootId,
  selectedId,
  onSelect,
  onOpenDetails,
  onStartChild,
  layoutNonce,
}) {
  const reactFlowRef = useRef(null);
  const initialViewCenteredRef = useRef(false);
  const rootNodeId = viewRootId || ROOT_ID;
  const appliedLayoutKeyRef = useRef("");
  const layoutStructureKey = useMemo(
    () =>
      JSON.stringify({
        layoutNonce,
        rootNodeId,
        workItems: workItems.map((item) => [
          item.id,
          item.parentId,
          item.type,
        ]),
      }),
    [layoutNonce, rootNodeId, workItems]
  );
  const actions = useMemo(
    () => ({
      onStartChild,
    }),
    [onStartChild]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const connectorEdges = useMemo(
    () =>
      buildBranchConnectorEdges(
        nodes,
        workItems,
        !viewRootId,
        rootNodeId
      ),
    [nodes, rootNodeId, viewRootId, workItems]
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
        rootTitle,
        rootDocketState,
        storyPointTotals,
        viewRootId,
        selectedId,
        existingPositions,
        actions,
      }), workItems, rootNodeId);

      return reconcileNodes(currentNodes, nextNodes);
    });
  }, [
    actions,
    rootDocketState,
    rootTitle,
    rootNodeId,
    selectedId,
    setNodes,
    storyPointTotals,
    viewRootId,
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
        rootTitle,
        rootDocketState,
        storyPointTotals,
        viewRootId,
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
        buildLayoutEdges(workItems, !viewRootId),
        rootNodeId
      );
      const nextNodes = withSeparatorGuideNodes(layout.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          position: node.position,
        },
      })), workItems, rootNodeId);
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
    rootTitle,
    rootNodeId,
    selectedId,
    setNodes,
    storyPointTotals,
    viewRootId,
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
      onOpenDetails(node.id);
    },
    [onOpenDetails]
  );

  const handlePaneClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

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
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        minZoom={0.25}
        onInit={(instance) => {
          reactFlowRef.current = instance;
          centerInitialViewOnRoot(nodes);
        }}
      >
        <Controls />
        <Background color="#242b38" gap={22} size={1} />
      </ReactFlow>
    </div>
  );
}
