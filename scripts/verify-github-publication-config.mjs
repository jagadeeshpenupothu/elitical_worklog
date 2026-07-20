import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GITHUB_PUBLICATION_ENV_KEYS,
  REQUIRED_GITHUB_PUBLICATION_ENV_KEYS,
  githubPublicationReadiness,
  provisionGithubPublicationConfig,
  resolveGithubPublicationConfig,
} from "../local-backend/services/GitHubPublicationConfigService.mjs";
import { getStoragePaths } from "../local-backend/services/StoragePathService.mjs";

const fixtureToken = "fixture-token-value-never-print";
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-github-config-"));

function source(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

try {
  const paths = getStoragePaths(path.join(fixtureRoot, "Elitical Worklog Data"));
  const projectFixture = path.join(fixtureRoot, "project");
  const repoEnvPath = path.join(projectFixture, ".env");

  await write(
    repoEnvPath,
    [
      `GITHUB_TOKEN=${fixtureToken}`,
      "GITHUB_DATA_OWNER=fixture-owner",
      "GITHUB_DATA_REPO=fixture-repo",
      "GITHUB_DATA_BRANCH=fixture-branch",
      "GITHUB_DATA_PATH=data/worklog.json",
      "GITHUB_CACHE_PATH=data",
      "ELITICAL_BASE_URL=https://example.invalid",
      "UNRELATED_SECRET=must-not-copy",
      "",
    ].join("\n")
  );

  const explicit = await resolveGithubPublicationConfig({
    env: {
      GITHUB_TOKEN: fixtureToken,
      GITHUB_DATA_OWNER: "owner-from-env",
      GITHUB_DATA_REPO: "repo-from-env",
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: projectFixture,
    paths,
  });

  assert.equal(explicit.ok, true, "explicit process.env GitHub config resolves");
  assert.equal(explicit.config.owner, "owner-from-env");
  assert.equal(explicit.config.branch, "main", "branch defaults to main");
  assert.equal(explicit.config.path, "data/worklog.json", "data path defaults safely");
  assert.equal(explicit.config.cacheDir, "data", "cache path defaults to the data path directory");

  const missingToken = await resolveGithubPublicationConfig({
    env: {
      GITHUB_DATA_OWNER: "owner",
      GITHUB_DATA_REPO: "repo",
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: projectFixture,
    paths,
  });
  assert.deepEqual(missingToken.missing, ["GITHUB_TOKEN"]);

  const missingOwner = await resolveGithubPublicationConfig({
    env: {
      GITHUB_TOKEN: fixtureToken,
      GITHUB_DATA_REPO: "repo",
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: projectFixture,
    paths,
  });
  assert.deepEqual(missingOwner.missing, ["GITHUB_DATA_OWNER"]);

  const missingRepo = await resolveGithubPublicationConfig({
    env: {
      GITHUB_TOKEN: fixtureToken,
      GITHUB_DATA_OWNER: "owner",
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: projectFixture,
    paths,
  });
  assert.deepEqual(missingRepo.missing, ["GITHUB_DATA_REPO"]);

  assert.equal(
    missingRepo.ok,
    false,
    "token + owner without repo must not pass GitHub publication validation"
  );

  const devFallback = await resolveGithubPublicationConfig({
    env: {
      ELITICAL_ENV_PATH: path.join(fixtureRoot, "missing-explicit.env"),
    },
    cwd: projectFixture,
    paths,
  });

  assert.equal(devFallback.ok, true, "missing ELITICAL_ENV_PATH can fall back in development");
  assert.equal(devFallback.config.repo, "fixture-repo");
  assert.equal(
    devFallback.diagnostics.sources.some(
      (entry) => entry.kind === "explicit-elitical-env-path" && entry.missing
    ),
    true,
    "missing explicit env path is diagnosed"
  );
  assert.equal(
    devFallback.diagnostics.sources.some(
      (entry) => entry.kind === "development-repo-env" && entry.loaded
    ),
    true,
    "development repo .env fallback is recorded"
  );

  await fs.mkdir(paths.configDir, { recursive: true });
  await write(
    paths.githubPublicationEnvPath,
    [
      `GITHUB_TOKEN=${fixtureToken}`,
      "GITHUB_DATA_OWNER=durable-owner",
      "GITHUB_DATA_REPO=durable-repo",
      "GITHUB_DATA_BRANCH=durable-branch",
      "GITHUB_DATA_PATH=published/cache.json",
      "",
    ].join("\n")
  );

  const durable = await resolveGithubPublicationConfig({
    env: {
      GITHUB_PUBLICATION_ENV_PATH: paths.githubPublicationEnvPath,
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: "0",
    },
    cwd: projectFixture,
    paths,
  });

  assert.equal(durable.ok, true, "durable app config resolves");
  assert.equal(durable.config.owner, "durable-owner");
  assert.equal(durable.config.repo, "durable-repo");
  assert.equal(durable.config.branch, "durable-branch");
  assert.equal(durable.config.path, "published/cache.json");
  assert.equal(durable.config.cacheDir, "published");

  const readiness = githubPublicationReadiness(durable);
  const readinessJson = JSON.stringify(readiness);

  assert.equal(readiness.configured, true);
  assert.deepEqual(readiness.missing, []);
  assert.doesNotMatch(readinessJson, new RegExp(fixtureToken), "readiness does not expose token values");
  assert.match(readinessJson, /GITHUB_TOKEN/, "readiness may expose missing/configured key names");

  const bootstrapTarget = path.join(fixtureRoot, "bootstrap-root", "config", "github-publication.env");
  const bootstrap = await provisionGithubPublicationConfig({
    sourceEnvPath: repoEnvPath,
    targetEnvPath: bootstrapTarget,
    env: {},
  });
  const bootstrappedRaw = await source(bootstrapTarget);

  assert.equal(bootstrap.status, "completed-created");
  assert.deepEqual(
    bootstrap.copiedKeys,
    GITHUB_PUBLICATION_ENV_KEYS,
    "bootstrap copies only approved GitHub publication keys that are present"
  );
  assert.match(bootstrappedRaw, /GITHUB_TOKEN=/);
  assert.match(bootstrappedRaw, /GITHUB_DATA_OWNER=/);
  assert.match(bootstrappedRaw, /GITHUB_DATA_REPO=/);
  assert.doesNotMatch(bootstrappedRaw, /ELITICAL_BASE_URL/);
  assert.doesNotMatch(bootstrappedRaw, /UNRELATED_SECRET/);

  if (process.platform !== "win32") {
    const mode = (await fs.stat(bootstrapTarget)).mode & 0o777;
    assert.equal(mode, 0o600, "durable GitHub config uses restrictive file permissions");
  }

  const bootstrappedRawBeforeSecondRun = await source(bootstrapTarget);
  const secondBootstrap = await provisionGithubPublicationConfig({
    sourceEnvPath: repoEnvPath,
    targetEnvPath: bootstrapTarget,
    env: {},
  });

  assert.equal(secondBootstrap.status, "already-configured");
  assert.deepEqual(secondBootstrap.copiedKeys, []);
  assert.equal(await source(bootstrapTarget), bootstrappedRawBeforeSecondRun, "bootstrap is idempotent");

  const preserveTarget = path.join(fixtureRoot, "preserve-root", "config", "github-publication.env");
  await write(
    preserveTarget,
    [
      "GITHUB_TOKEN=existing-token",
      "GITHUB_DATA_OWNER=existing-owner",
      "GITHUB_DATA_REPO=existing-repo",
      "",
    ].join("\n")
  );
  const preserve = await provisionGithubPublicationConfig({
    sourceEnvPath: repoEnvPath,
    targetEnvPath: preserveTarget,
    env: {},
  });
  const preservedRaw = await source(preserveTarget);

  assert.equal(preserve.status, "already-configured");
  assert.match(preservedRaw, /existing-token/);
  assert.doesNotMatch(preservedRaw, new RegExp(fixtureToken), "valid durable config is not overwritten");

  assert.equal(paths.githubPublicationEnvPath, path.join(paths.root, "config", "github-publication.env"));
  assert.equal(paths.githubPublicationEnvPath.includes(".app"), false, "durable config is outside .app");
  assert.equal(paths.githubPublicationEnvPath.includes("0.0.4"), false, "durable config is version-independent");

  const electronSource = await source("electron/main.mjs");
  assert.match(electronSource, /GITHUB_PUBLICATION_ENV_PATH/);
  assert.match(electronSource, /ELITICAL_DESKTOP_PACKAGED/);
  assert.match(electronSource, /ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK/);
  assert.match(electronSource, /app\.isPackaged \? "0" : "1"/);

  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(packageJson.version, "0.0.4", "current version remains 0.0.4");
  assert.equal(packageJson.scripts["setup:github-publication"], "node scripts/setup-github-publication.mjs");
  assert.equal(
    packageJson.scripts["verify:github-publication-config"],
    "node scripts/verify-github-publication-config.mjs"
  );
  assert.equal(
    packageJson.build.files.some((entry) => entry.includes(".env") || entry.includes("github-publication.env")),
    false,
    "electron-builder files do not package GitHub publication secrets"
  );

  const buildDmgSource = await source("scripts/build-dmg.mjs");
  assert.doesNotMatch(buildDmgSource, /GITHUB_TOKEN/);
  assert.doesNotMatch(buildDmgSource, /github-publication\.env/);

  const githubDataSource = await source("local-backend/services/GitHubDataService.mjs");
  assert.match(githubDataSource, /resolveGithubPublicationConfig/);
  assert.doesNotMatch(githubDataSource, /process\.env\.GITHUB_TOKEN && process\.env\.GITHUB_DATA_OWNER\) return/);

  const serverSource = await source("local-backend/server.mjs");
  assert.match(serverSource, /\/api\/config\/github-publication/);
  assert.match(serverSource, /\/api\/publish\/latest-snapshot/);
  assert.match(serverSource, /publishLatestLocalSnapshot/);

  const syncServiceSource = await source("local-backend/services/SyncService.mjs");
  assert.match(syncServiceSource, /const publication = await this\.publishSnapshot/);
  assert.match(syncServiceSource, /local-synced-publication-failed/);
  assert.match(syncServiceSource, /return payload;/);

  await fs.rm(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  throw error;
}

console.log("GitHub publication configuration verification PASS");
