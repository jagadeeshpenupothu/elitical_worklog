export function canonicalNodeType(node) {
  if (!node) return "";
  if (node.isOrphanSprint) return "orphan-sprint";
  if (node.type === "main-root" || node.type === "story-root") return "";
  if (node.nodeType === "project" || node.isProjectNode) return "";
  if (node.nodeType === "sprint" || node.isSprintNode) return "";

  return node.type || "";
}

export function childCreateTypesForCanonicalType(type) {
  if (type === "orphan-sprint") return ["epic"];
  if (type === "epic") return ["story", "task"];
  if (type === "story") return ["job"];

  return [];
}

export function childCreateTypesForNode(node) {
  if (node?.allowChildActions === false) return [];

  return childCreateTypesForCanonicalType(canonicalNodeType(node));
}

export function canCreateChildForNode(node) {
  return childCreateTypesForNode(node).length > 0;
}
