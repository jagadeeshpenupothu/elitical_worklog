import { EliticalAuthService } from "../src/services/elitical/auth/index";
import { EliticalClient } from "../src/services/elitical/client/index";
import { EliticalProvider } from "../src/services/elitical/provider/index";
import { createSyncManager } from "../src/services/elitical/sync.js";

function itemId(item: { id?: string; eliticalId?: string; docketId?: string; dktId?: string; cx?: string }): string {
  return String(item.id || item.eliticalId || item.docketId || item.dktId || item.cx || "");
}

async function main() {
  const baseUrl = process.env.ELITICAL_BASE_URL || "";
  const dataDir = process.env.ELITICAL_DATA_DIR || "";

  const authService = new EliticalAuthService({
    baseUrl,
    dataDir: dataDir || undefined,
  });

  await authService.initialize();

  const session = await authService.restoreSession();

  if (!session) {
    await authService.login();
  }

  const client = new EliticalClient(authService);
  const provider = new EliticalProvider(client);
  const syncManager = createSyncManager({ provider });
  const officialData = await syncManager.downloadOfficialData();
  const firstDocketId = itemId(officialData.dockets[0] || {});
  let docketLoaded = false;

  if (firstDocketId) {
    await provider.getDocket(firstDocketId);
    docketLoaded = true;
  }

  console.log("✔ Projects", officialData.project ? 1 : 0);
  console.log("✔ Sprints", officialData.sprints.length);
  console.log("✔ Issues", officialData.dockets.length);
  console.log("✔ Dockets", docketLoaded ? 1 : 0);
  console.log("✔ Worklogs", officialData.worklogs.length);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
