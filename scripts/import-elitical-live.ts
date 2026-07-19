import { importEliticalLiveToNormalized } from "../src/services/elitical/syncLive.js";

async function main() {
  const result = await importEliticalLiveToNormalized({
    writeOutput: true,
    onProgress(progress) {
      if (progress.phase === "fetching-details") return;
      console.log(progress.message);
    },
  });

  console.log("Total IssuesBoard dockets:", result.issues.total);
  console.log("Total Docket detail requests:", result.detailRequests.total);
  console.log("Successful detail requests:", result.detailRequests.successful);
  console.log("Failed detail requests:", result.detailRequests.failed);
  console.log("Imported Dockets:", result.worklogImport.importedDockets);
  console.log("Imported Worklogs:", result.worklogImport.importedWorklogs);
  console.log("Worklog requests sent:", result.worklogImport.requestedDockets);
  console.log("Worklog dockets reused:", result.worklogImport.reusedDockets);
  console.log(JSON.stringify(result.counts, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
