import yaml from "js-yaml";

export function parseYamlToGraph(yamlText) {
  const data = yaml.load(yamlText);

  const nodes = [];
  const edges = [];
  const tickets = [];

  function calculateStoryPoints(item) {
    if (!item.children) {
      return item.storyPoints || 0;
    }

    let total = 0;

    Object.values(item.children).forEach((child) => {
      total += calculateStoryPoints(child);
    });

    return total;
  }

  function traverse(id, item, parentId = null) {
    const storyPoints = calculateStoryPoints(item);

    tickets.push({
      id,
      title: item.title || id,
      description: item.description || "",

      type: item.type || "Task",

      assignee: item.assignee || "",
      priority: item.priority || "",
      status: item.status || "",

      sprint: item.sprint || "",
      milestone: item.milestone || "",

      startDate: item.startDate || "",
      endDate: item.endDate || "",

      storyPoints,
      parentId,
    });

    nodes.push({
      id,
      type: "jiraNode",

      data: {
        title: id,
        label: item.title || id,

        type: (item.type || "task").toLowerCase(),

        storyPoints,

        assignee: item.assignee || "",
        priority: item.priority || "",
        status: item.status || "",

        description: item.description || "",

        sprint: item.sprint || "",
        milestone: item.milestone || "",

        startDate: item.startDate || "",
        endDate: item.endDate || "",
      },
    });

    if (parentId) {
      edges.push({
        id: `${parentId}-${id}`,

        source: parentId,
        target: id,

        type: "smoothstep",

        pathOptions: {
          borderRadius: 20,
        },

        animated: false,

        style: {
          stroke: "#60a5fa",
          strokeWidth: 3,
        },
      });
    }

    if (item.children) {
      Object.entries(item.children).forEach(
        ([childId, childItem]) => {
          traverse(childId, childItem, id);
        }
      );
    }
  }

  Object.entries(data).forEach(
    ([rootId, rootItem]) => {
      traverse(rootId, rootItem);
    }
  );

  return {
    nodes,
    edges,
    tickets,
  };
}