export function getNodeSize(node) {
  const measured = node.measured || {
    width: node.width,
    height: node.height,
  };

  if (
    Number.isFinite(measured.width) &&
    Number.isFinite(measured.height) &&
    measured.width > 0 &&
    measured.height > 0
  ) {
    return {
      width: measured.width,
      height: measured.height,
    };
  }

  return {
    width: 240,
    height: 58,
  };
}

export function getNodeRank(node) {
  if (node.id === "storyRoot" || node.data?.type === "story-root") {
    return 0;
  }

  if (node.data?.type === "epic") return 1;
  if (node.data?.type === "story") return 2;
  if (node.data?.type === "task") return 2;
  if (node.data?.type === "job") return 3;

  return 0;
}

const RANK_GAP = 112;

export function getRankYs(nodes, rootY = 64, rankGap = RANK_GAP, rankForNode = getNodeRank) {
  const maxHeightsByRank = nodes.reduce((acc, node) => {
    const rank = rankForNode(node);
    const size = getNodeSize(node);
    acc[rank] = Math.max(acc[rank] || 0, size.height);
    return acc;
  }, {});
  const rankYs = {
    0: rootY,
  };
  const maxRank = Math.max(
    3,
    ...Object.keys(maxHeightsByRank).map((rank) => Number(rank))
  );

  for (let rank = 1; rank <= maxRank; rank += 1) {
    const previousHeight = maxHeightsByRank[rank - 1] || 58;
    rankYs[rank] = rankYs[rank - 1] + previousHeight + rankGap;
  }

  return rankYs;
}

function getChildGap(parentNode) {
  const parentType = parentNode?.data?.type;

  if (parentType === "story-root") return 120;
  if (parentType === "epic") return 96;
  if (parentType === "story") return 36;

  return 56;
}

export function getLayoutedElements(nodes, edges, rootId = "storyRoot") {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = edges.reduce((acc, edge) => {
    if (!acc[edge.source]) acc[edge.source] = [];
    acc[edge.source].push(edge.target);
    return acc;
  }, {});
  const rootNode = byId.get(rootId) || byId.get("storyRoot") || nodes[0];
  const rootY = rootNode?.position?.y ?? 64;
  const ranksById = new Map();
  const queue = rootNode ? [{ id: rootNode.id, rank: 0 }] : [];

  while (queue.length > 0) {
    const { id, rank } = queue.shift();

    if (ranksById.has(id)) continue;

    ranksById.set(id, rank);
    (childrenByParent[id] || []).forEach((childId) => {
      queue.push({
        id: childId,
        rank: rank + 1,
      });
    });
  }

  const rankYs = getRankYs(
    nodes,
    rootY,
    RANK_GAP,
    (node) => ranksById.get(node.id) ?? getNodeRank(node)
  );
  const subtreeWidths = new Map();

  function measureSubtree(id) {
    const node = byId.get(id);
    if (!node) return 0;

    const size = getNodeSize(node);
    const childIds = childrenByParent[id] || [];

    if (childIds.length === 0) {
      subtreeWidths.set(id, size.width);
      return size.width;
    }

    const childGap = getChildGap(node);
    const childrenWidth =
      childIds.reduce(
        (total, childId) => total + measureSubtree(childId),
        0
      ) +
      childGap * (childIds.length - 1);
    const width = Math.max(size.width, childrenWidth);
    subtreeWidths.set(id, width);
    return width;
  }

  function placeSubtree(id, centerX, positions) {
    const node = byId.get(id);

    if (!node) return;

    const size = getNodeSize(node);
    const rank = ranksById.get(id) ?? getNodeRank(node);
    const childIds = childrenByParent[id] || [];

    positions[id] = {
      x: centerX - size.width / 2,
      y: rankYs[rank],
    };

    if (childIds.length === 0) return;

    const childGap = getChildGap(node);
    const childrenWidth =
      childIds.reduce(
        (total, childId) => total + (subtreeWidths.get(childId) || 0),
        0
      ) +
      childGap * (childIds.length - 1);
    let cursor = centerX - childrenWidth / 2;

    childIds.forEach((childId) => {
      const childWidth = subtreeWidths.get(childId) || 0;
      placeSubtree(childId, cursor + childWidth / 2, positions);
      cursor += childWidth + childGap;
    });
  }

  measureSubtree(rootNode?.id);

  const positions = {};
  const rootSize = getNodeSize(rootNode);
  const rootCenterX =
    (rootNode?.position?.x ?? 0) + rootSize.width / 2;

  placeSubtree(rootNode?.id, rootCenterX, positions);

  return {
    nodes: nodes.map((node) => ({
      ...node,
      position: positions[node.id] || node.position,
    })),
    edges,
  };
}
