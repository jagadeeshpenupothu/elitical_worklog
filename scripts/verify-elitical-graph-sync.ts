import { createSyncManager } from "../src/services/elitical/sync.js";
import {
  buildWorklogSnapshot,
  generateViewGraph,
  normalizeWorklogSnapshot,
} from "../src/utils/worklogModel.js";

function countByType(items: Array<{ type?: string }>, type: string) {
  return items.filter((item) => item.type === type).length;
}

async function main() {
  const syncManager = createSyncManager();
  const officialData = await syncManager.downloadOfficialData();
  const baseline = buildWorklogSnapshot({
    mainTitle: "Genesis",
    rootTitle: officialData.sprint?.name || "Sprint View",
    rootDocketState: "concept",
    sprints: [],
    workItems: [],
  });

  if (!baseline.valid || !baseline.snapshot) {
    throw new Error(baseline.error || "Unable to create baseline graph snapshot.");
  }

  const mergedSnapshot = syncManager.mergeWithGitHub({
    officialData,
    githubSnapshot: baseline.snapshot,
  });
  const normalized = normalizeWorklogSnapshot(mergedSnapshot);

  if (!normalized.valid || !normalized.snapshot) {
    throw new Error(normalized.error || "Unable to normalize Elitical graph snapshot.");
  }

  const graph = generateViewGraph(normalized.snapshot, "main");
  const graphNodes = graph.nodes || [];

  console.log("✔ Projects", officialData.project ? 1 : 0);
  console.log("✔ Sprints", officialData.sprints.length);
  console.log("✔ Issues", officialData.dockets.length);
  console.log("✔ Dockets", countByType(graphNodes, "epic") + countByType(graphNodes, "story") + countByType(graphNodes, "job"));
  console.log("✔ Worklogs", officialData.worklogs.length);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
