import normalizedEliticalData from "../../data/elitical-normalized.json";

export function loadEliticalData() {
  return normalizedEliticalData.appState;
}

export function loadEliticalEpicPresets() {
  return (normalizedEliticalData.epics || [])
    .filter((epic) => epic.num)
    .map((epic) => ({
      id: epic.id,
      title: epic.title,
      description: epic.description || "",
      category: epic.category || "feature",
      sprint: "",
      docketState: epic.docketState || "concept",
      assignee: epic.assigneeName || "",
      createdBy: epic.createdBy || "",
      createdAt: epic.createdAt || undefined,
      updatedBy: epic.updatedBy || "",
      updatedAt: epic.updatedAt || epic.createdAt || undefined,
    }));
}

export { normalizedEliticalData };
