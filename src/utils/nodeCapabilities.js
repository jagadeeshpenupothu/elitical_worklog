export function canonicalNodeType(node) {
  if (!node) return "";
  if (node.isOrphanSprint) return "orphan-sprint";
  if (node.type === "main-root" || node.type === "story-root") return "";
  if (node.nodeType === "project" || node.isProjectNode) return "";
  if (node.nodeType === "sprint" || node.isSprintNode) return "sprint";

  return node.type || "";
}

export function childCreateTypesForCanonicalType(type) {
  if (type === "sprint") return ["epic"];
  if (type === "orphan-sprint") return ["epic"];
  if (type === "epic") return ["story", "task"];
  if (type === "story") return ["job"];

  return [];
}

export function childAddExistingTypesForCanonicalType(type) {
  if (type === "sprint") return ["epic"];
  if (type === "orphan-sprint") return ["epic"];
  if (type === "epic") return ["story"];

  return [];
}

export function childCreateTypesForNode(node) {
  if (node?.allowChildActions === false) return [];

  return childCreateTypesForCanonicalType(canonicalNodeType(node));
}

export function childAddExistingTypesForNode(node) {
  if (node?.allowChildActions === false) return [];

  return childAddExistingTypesForCanonicalType(canonicalNodeType(node));
}

export function childActionItemsForNode(node) {
  const addExistingTypes = childAddExistingTypesForNode(node);

  return childCreateTypesForNode(node).flatMap((type) => [
    ...(addExistingTypes.includes(type)
      ? [
          {
            kind: "add-existing",
            type,
            label: `Add Existing ${type.charAt(0).toUpperCase()}${type.slice(1)}`,
          },
        ]
      : []),
    {
      kind: "create",
      type,
      label: `Create New ${type.charAt(0).toUpperCase()}${type.slice(1)}`,
    },
  ]);
}

export function canCreateChildForNode(node) {
  return childCreateTypesForNode(node).length > 0;
}
