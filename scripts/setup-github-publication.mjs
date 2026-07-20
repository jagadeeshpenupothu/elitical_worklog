import path from "node:path";
import {
  GITHUB_PUBLICATION_ENV_KEYS,
  provisionGithubPublicationConfig,
  resolveGithubPublicationConfig,
} from "../local-backend/services/GitHubPublicationConfigService.mjs";
import { getStoragePaths } from "../local-backend/services/StoragePathService.mjs";

const sourceEnvPath = path.resolve(process.cwd(), ".env");
const targetEnvPath = getStoragePaths().githubPublicationEnvPath;

function publicResult(result, readiness) {
  return {
    status: result.status,
    targetEnvPath: result.targetEnvPath,
    copiedKeys: result.copiedKeys.filter((key) => key !== "GITHUB_TOKEN"),
    tokenCopied: result.copiedKeys.includes("GITHUB_TOKEN"),
    configured: readiness.ok,
    missing: readiness.missing,
    approvedKeys: GITHUB_PUBLICATION_ENV_KEYS,
  };
}

try {
  const result = await provisionGithubPublicationConfig({
    sourceEnvPath,
    targetEnvPath,
  });
  const readiness = await resolveGithubPublicationConfig({
    env: {
      GITHUB_PUBLICATION_ENV_PATH: targetEnvPath,
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: process.cwd(),
    paths: getStoragePaths(),
  });

  console.log(JSON.stringify(publicResult(result, readiness), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    message: error?.message || "GitHub publication setup failed.",
    missing: error?.missing || [],
    targetEnvPath,
  }, null, 2));
  process.exit(1);
}
