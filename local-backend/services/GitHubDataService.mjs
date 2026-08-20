import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertSnapshotBundle,
  snapshotDescriptorFor,
  snapshotIdsMatch,
} from "./SynchronizedSnapshotService.mjs";
import {
  githubPublicationReadiness,
  resolveGithubPublicationConfig,
} from "./GitHubPublicationConfigService.mjs";

let latestPublicationSequence = 0;
const execFileAsync = promisify(execFile);
// GitHub's Contents API requires base64 content inside a JSON body, so the
// request can be much larger than the raw JSON file. Keep this threshold below
// the observed 10 MB-class failure range so growing snapshots switch to git
// transport before GitHub can reject the request as malformed.
export const GITHUB_CONTENTS_API_SAFE_BODY_BYTES = 8_000_000;

function jsonFileContent(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function hasBase64Content(file) {
  return typeof file?.content === "string" && file.content.trim().length > 0;
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function contentsApiRequestBodyForJson({ message, content, branch, sha }) {
  return JSON.stringify({
    message,
    content: encodeBase64(content),
    ...(sha ? { sha } : {}),
    branch,
  });
}

export function contentsApiRequestBodyBytes({ message, content, branch, sha }) {
  return Buffer.byteLength(
    contentsApiRequestBodyForJson({
      message,
      content,
      branch,
      sha,
    })
  );
}

export function contentsApiRequestIsSafe({ message, content, branch, sha }) {
  return (
    contentsApiRequestBodyBytes({
      message,
      content,
      branch,
      sha,
    }) <= GITHUB_CONTENTS_API_SAFE_BODY_BYTES
  );
}

function cleanPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/(ELITICAL_BASE_URL|GITHUB_TOKEN|GITHUB_DATA_OWNER|GITHUB_DATA_REPO|GITHUB_DATA_BRANCH)=.*$/, "")
    .replace(/^\/+/, "");
}

export function githubDataConfigFromEnv(env = process.env) {
  const basePath = cleanPath(env.GITHUB_DATA_PATH || "data/worklog.json");
  const cacheDir = cleanPath(env.GITHUB_CACHE_PATH || path.posix.dirname(basePath || "data/worklog.json"));
  const config = {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_DATA_OWNER,
    repo: env.GITHUB_DATA_REPO,
    branch: env.GITHUB_DATA_BRANCH || "main",
    path: basePath,
    cacheDir,
  };
  const missing = [
    ["GITHUB_TOKEN", config.token],
    ["GITHUB_DATA_OWNER", config.owner],
    ["GITHUB_DATA_REPO", config.repo],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return missing.length > 0
    ? { ok: false, missing, config }
    : { ok: true, missing: [], config };
}

export async function githubDataConfig() {
  return resolveGithubPublicationConfig();
}

export async function githubPublicationStatus() {
  return githubPublicationReadiness(await githubDataConfig());
}

export function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function githubFileUrl({ owner, repo, path: filePath }) {
  return `https://api.github.com/repos/${encodeURIComponent(
    owner
  )}/${encodeURIComponent(repo)}/contents/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function githubRequestErrorMessage({
  action,
  filePath,
  status,
  payload,
  fallback = "GitHub request failed.",
}) {
  const detail = payload?.message || fallback;
  const location = filePath ? ` for ${filePath}` : "";
  const statusText = status ? ` (${status})` : "";

  return `${action}${statusText}${location}: ${detail}`;
}

async function fetchGitHub(url, options, { action, filePath } = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const causeMessage =
      error?.cause?.message && error.cause.message !== error.message
        ? `: ${error.cause.message}`
        : "";
    const requestError = new Error(
      githubRequestErrorMessage({
        action,
        filePath,
        status: 0,
        payload: {
          message: `${error?.message || "request failed"}${causeMessage}`,
        },
      })
    );

    requestError.statusCode = 0;
    requestError.code = error?.code || error?.cause?.code || "";
    requestError.cause = error;
    throw requestError;
  }
}

export function cacheFilePath(config, fileName) {
  const cacheDir = cleanPath(config.cacheDir || "data");

  return cacheDir ? `${cacheDir}/${fileName}` : fileName;
}

function assertSafeRepoPath(filePath) {
  const normalized = cleanPath(filePath);
  const parts = normalized.split("/");

  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    const error = new Error(`GitHub publication file path is invalid: ${filePath}`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function unsafeContentsApiRequestError({ filePath, bodyBytes }) {
  const error = new Error(
    `GitHub Contents API request is too large for ${filePath}: ${bodyBytes} bytes exceeds the safe ${GITHUB_CONTENTS_API_SAFE_BODY_BYTES} byte limit. Use git publication transport.`
  );

  error.statusCode = 413;
  error.transport = "contents-api";
  error.filePath = filePath;
  error.bodyBytes = bodyBytes;
  throw error;
}

function githubNeedsShaForExistingFile({ status, payload }) {
  return (
    status === 422 &&
    /sha/i.test(String(payload?.message || "")) &&
    /supplied|required/i.test(String(payload?.message || ""))
  );
}

export function publicationFilesForSnapshot({ graph, worklogs, metadata, config }) {
  return [
    ["graph.json", graph],
    ["worklogs.json", worklogs],
    ["metadata.json", metadata],
  ].map(([fileName, payload]) => ({
    fileName,
    filePath: cacheFilePath(config, fileName),
    payload,
    content: jsonFileContent(payload),
  }));
}

export function githubPublicationTransportForFiles({
  files,
  message,
  branch,
  assumeUpdateSha = "0000000000000000000000000000000000000000",
} = {}) {
  const unsafeFile = files.find((file) => {
    const bodyBytes = contentsApiRequestBodyBytes({
      message,
      content: file.content,
      branch,
      sha: assumeUpdateSha,
    });

    file.contentsApiBodyBytes = bodyBytes;

    return bodyBytes > GITHUB_CONTENTS_API_SAFE_BODY_BYTES;
  });

  return unsafeFile
    ? {
        transport: "git",
        reason: "contents-api-body-too-large",
        filePath: unsafeFile.filePath,
        bodyBytes: unsafeFile.contentsApiBodyBytes,
        safeBodyBytes: GITHUB_CONTENTS_API_SAFE_BODY_BYTES,
      }
    : {
        transport: "contents-api",
        reason: "contents-api-body-safe",
        bodyBytes: Math.max(0, ...files.map((file) => file.contentsApiBodyBytes || 0)),
        safeBodyBytes: GITHUB_CONTENTS_API_SAFE_BODY_BYTES,
      };
}

export async function getGitHubFile(config, filePath = config.path) {
  const response = await fetchGitHub(
    `${githubFileUrl({ ...config, path: filePath })}?ref=${encodeURIComponent(config.branch)}`,
    {
      headers: githubHeaders(config.token),
    },
    {
      action: "GitHub load request failed",
      filePath,
    }
  );
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 404) {
      const error = new Error("GitHub data file was not found.");
      error.statusCode = 404;
      throw error;
    }

    const error = new Error(
      githubRequestErrorMessage({
        action: "GitHub load failed",
        filePath,
        status: response.status,
        payload,
        fallback: "GitHub load failed.",
      })
    );
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }

  if (!payload?.sha || (typeof payload.content !== "string" && !payload.download_url)) {
    const error = new Error("GitHub file response was malformed.");
    error.statusCode = 502;
    throw error;
  }

  return payload;
}

async function loadRawGitHubFile(config, file) {
  if (!file.download_url) {
    const error = new Error("GitHub file response did not include downloadable content.");
    error.statusCode = 502;
    throw error;
  }

  const response = await fetchGitHub(
    file.download_url,
    {
      headers: githubHeaders(config.token),
    },
    {
      action: "GitHub raw file download request failed",
      filePath: file.path || "",
    }
  );

  if (!response.ok) {
    const error = new Error(
      githubRequestErrorMessage({
        action: "GitHub raw file download failed",
        filePath: file.path || "",
        status: response.status,
        payload: null,
        fallback: "GitHub raw file download failed.",
      })
    );
    error.statusCode = response.status;
    throw error;
  }

  return response.text();
}

export async function loadJsonFile(config, filePath = config.path) {
  const file = await getGitHubFile(config, filePath);
  const raw = hasBase64Content(file)
    ? decodeBase64(file.content)
    : await loadRawGitHubFile(config, file);

  try {
    return {
      payload: JSON.parse(raw),
      sha: file.sha,
      path: filePath,
    };
  } catch (err) {
    const error = new Error(`GitHub data file contained invalid JSON: ${filePath}`);
    error.statusCode = 502;
    error.cause = err;
    throw error;
  }
}

export async function putJsonFile(config, filePath, payload, { message } = {}) {
  const safeFilePath = assertSafeRepoPath(filePath);
  let current = null;

  try {
    current = await getGitHubFile(config, safeFilePath);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  const content = jsonFileContent(payload);
  const putWithCurrentSha = async (sha) => {
    const requestBody = contentsApiRequestBodyForJson({
      message: message || `data: update ${safeFilePath}`,
      content,
      branch: config.branch,
      sha,
    });
    const bodyBytes = Buffer.byteLength(requestBody);

    if (bodyBytes > GITHUB_CONTENTS_API_SAFE_BODY_BYTES) {
      unsafeContentsApiRequestError({
        filePath: safeFilePath,
        bodyBytes,
      });
    }

    const response = await fetchGitHub(
      githubFileUrl({ ...config, path: safeFilePath }),
      {
        method: "PUT",
        headers: {
          ...githubHeaders(config.token),
          "Content-Type": "application/json",
        },
        body: requestBody,
      },
      {
        action: "GitHub save request failed",
        filePath: safeFilePath,
      }
    );
    const result = await response.json().catch(() => null);

    return {
      response,
      result,
    };
  };
  let { response, result } = await putWithCurrentSha(current?.sha);

  if (githubNeedsShaForExistingFile({ status: response.status, payload: result }) && !current?.sha) {
    current = await getGitHubFile(config, safeFilePath);
    ({ response, result } = await putWithCurrentSha(current?.sha));
  }

  if (!response.ok) {
    const error = new Error(
      githubRequestErrorMessage({
        action: "GitHub save failed",
        filePath: safeFilePath,
        status: response.status,
        payload: result,
        fallback: "GitHub save failed.",
      })
    );
    error.statusCode = response.status;
    error.payload = result;
    throw error;
  }

  if (!result?.content?.sha) {
    const error = new Error("GitHub save response was malformed.");
    error.statusCode = 502;
    throw error;
  }

  return {
    path: safeFilePath,
    sha: result.content.sha,
    commitSha: result.commit?.sha || "",
  };
}

async function writeAskPassScript(token) {
  const askPassDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-git-askpass-"));
  const askPassPath = path.join(askPassDir, "askpass.sh");

  await fs.writeFile(
    askPassPath,
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      "  *) printf '%s\\n' \"$GIT_PUBLISH_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 }
  );

  return {
    askPassDir,
    askPassPath,
  };
}

async function runGit(args, { cwd, env, step }) {
  try {
    return await execFileAsync("git", args, {
      cwd,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const detail = stderr || stdout || error?.message || "git command failed";
    const gitError = new Error(`GitHub publication ${step} failed: ${detail}`);

    gitError.statusCode = 502;
    gitError.transport = "git";
    gitError.step = step;
    gitError.cause = error;
    throw gitError;
  }
}

async function publishCacheFilesWithGit({ config, files, message, bundle, descriptor, sequence }) {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-github-publish-"));
  const { askPassDir, askPassPath } = await writeAskPassScript(config.token);
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askPassPath,
    GIT_PUBLISH_TOKEN: config.token,
    GIT_TERMINAL_PROMPT: "0",
  };
  const remoteUrl = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}.git`;

  try {
    await runGit(["init"], { cwd: repoDir, env: gitEnv, step: "init" });
    await runGit(["remote", "add", "origin", remoteUrl], {
      cwd: repoDir,
      env: gitEnv,
      step: "remote setup",
    });
    await runGit(["config", "user.name", "Elitical Worklog"], {
      cwd: repoDir,
      env: gitEnv,
      step: "author setup",
    });
    await runGit(["config", "user.email", "elitical-worklog@users.noreply.github.com"], {
      cwd: repoDir,
      env: gitEnv,
      step: "author setup",
    });
    await runGit(["fetch", "--depth=1", "origin", config.branch], {
      cwd: repoDir,
      env: gitEnv,
      step: "fetch",
    });
    await runGit(["checkout", "-B", config.branch, "FETCH_HEAD"], {
      cwd: repoDir,
      env: gitEnv,
      step: "checkout",
    });

    for (const file of files) {
      const safeFilePath = assertSafeRepoPath(file.filePath);
      const destination = path.join(repoDir, ...safeFilePath.split("/"));

      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, "utf8");
    }

    await runGit(["add", "--", ...files.map((file) => assertSafeRepoPath(file.filePath))], {
      cwd: repoDir,
      env: gitEnv,
      step: "stage",
    });

    const status = await runGit(
      ["status", "--porcelain", "--", ...files.map((file) => assertSafeRepoPath(file.filePath))],
      { cwd: repoDir, env: gitEnv, step: "status" }
    );
    const changed = String(status.stdout || "").trim().length > 0;

    if (changed) {
      await runGit(["commit", "-m", message], {
        cwd: repoDir,
        env: gitEnv,
        step: "commit",
      });
      await runGit(["push", "origin", `HEAD:${config.branch}`], {
        cwd: repoDir,
        env: gitEnv,
        step: "push",
      });
    }

    const commit = await runGit(["rev-parse", "HEAD"], {
      cwd: repoDir,
      env: gitEnv,
      step: "resolve commit",
    });
    const commitSha = String(commit.stdout || "").trim();
    const published = [];

    for (const file of files) {
      const safeFilePath = assertSafeRepoPath(file.filePath);
      const blob = await runGit(["hash-object", "--", safeFilePath], {
        cwd: repoDir,
        env: gitEnv,
        step: "resolve blob",
      });

      published.push({
        path: safeFilePath,
        sha: String(blob.stdout || "").trim(),
        commitSha,
      });
    }

    return {
      status: "published",
      transport: "git",
      changed,
      publishedAt: new Date().toISOString(),
      snapshotId: bundle.snapshotId,
      syncGenerationId: descriptor.syncGenerationId,
      syncGenerationSequence: sequence,
      commitSha,
      files: published,
    };
  } finally {
    delete gitEnv.GIT_PUBLISH_TOKEN;
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(askPassDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function publishCacheFiles({
  graph,
  worklogs,
  metadata,
  message = "data: publish Elitical cache",
} = {}, {
  publicationConfig,
  contentsPublisher = putJsonFile,
  gitPublisher = publishCacheFilesWithGit,
} = {}) {
  const bundle = assertSnapshotBundle({ graph, worklogs, metadata });
  const descriptor = snapshotDescriptorFor(metadata);
  const sequence = descriptor.syncGenerationSequence || Date.now();

  latestPublicationSequence = Math.max(latestPublicationSequence, sequence);

  const env = publicationConfig || await githubDataConfig();

  if (!env.ok) {
    const error = new Error(
      `GitHub publication is missing required configuration: ${env.missing.join(", ")}.`
    );
    error.statusCode = 500;
    error.missing = env.missing;
    throw error;
  }

  const config = env.config;
  const messageText = message || "data: publish Elitical cache";
  const files = publicationFilesForSnapshot({ graph, worklogs, metadata, config });
  const published = [];
  const transportDecision = githubPublicationTransportForFiles({
    files,
    message: messageText,
    branch: config.branch,
  });

  // Keep a snapshot publication on one transport. Small files use the Contents
  // API for simple create/update + SHA semantics; if any encoded JSON body is
  // unsafe, the whole graph/worklogs/metadata batch switches to one git commit
  // so generations cannot be partially published.
  if (transportDecision.transport === "git") {
    return gitPublisher({
      config,
      files,
      message: messageText,
      bundle,
      descriptor,
      sequence,
      transportDecision,
    });
  }

  for (const file of files) {
    if (sequence < latestPublicationSequence) {
      const error = new Error("A newer synchronized snapshot is already being published.");
      error.statusCode = 409;
      error.snapshotId = descriptor.syncGenerationId;
      throw error;
    }

    published.push(
      await contentsPublisher(config, file.filePath, file.payload, {
        message: messageText,
      })
    );
  }

  return {
    status: "published",
    publishedAt: new Date().toISOString(),
    snapshotId: bundle.snapshotId,
    syncGenerationId: descriptor.syncGenerationId,
    syncGenerationSequence: sequence,
    transport: "contents-api",
    commitSha: published[published.length - 1]?.commitSha || "",
    files: published,
  };
}

export async function loadPublishedCacheFiles() {
  const env = await githubDataConfig();

  if (!env.ok) {
    const error = new Error("GitHub data repository is not configured.");
    error.statusCode = 500;
    error.missing = env.missing;
    throw error;
  }

  const config = env.config;
  const [graph, worklogs, metadata] = await Promise.all([
    loadJsonFile(config, cacheFilePath(config, "graph.json")),
    loadJsonFile(config, cacheFilePath(config, "worklogs.json")),
    loadJsonFile(config, cacheFilePath(config, "metadata.json")),
  ]);

  return {
    status: "hit",
    normalized: graph.payload,
    worklogs: worklogs.payload,
    metadata: metadata.payload,
    snapshot: {
      consistent: snapshotIdsMatch(graph.payload, worklogs.payload, metadata.payload),
      graph: snapshotDescriptorFor(graph.payload),
      worklogs: snapshotDescriptorFor(worklogs.payload),
      metadata: snapshotDescriptorFor(metadata.payload),
    },
    sha: {
      graph: graph.sha,
      worklogs: worklogs.sha,
      metadata: metadata.sha,
    },
  };
}

function withoutWorklogs(payload) {
  if (Array.isArray(payload)) return payload.map(withoutWorklogs);
  if (!payload || typeof payload !== "object") return payload;

  const next = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      key === "worklogs" && Array.isArray(value) ? [] : withoutWorklogs(value),
    ])
  );

  if (
    Array.isArray(payload.worklogs) &&
    payload.worklogs.length > 0 &&
    !next.primaryWorklogDate
  ) {
    next.primaryWorklogDate =
      payload.worklogs[0]?.date || payload.worklogs[0]?.worklogDate || "";
  }

  return next;
}

export async function loadPublishedGraphFiles() {
  const env = await githubDataConfig();

  if (!env.ok) {
    const error = new Error("GitHub data repository is not configured.");
    error.statusCode = 500;
    error.missing = env.missing;
    throw error;
  }

  const config = env.config;
  const [graph, metadata] = await Promise.all([
    loadJsonFile(config, cacheFilePath(config, "graph.json")),
    loadJsonFile(config, cacheFilePath(config, "metadata.json")),
  ]);

  return {
    status: "hit",
    normalized: withoutWorklogs(graph.payload),
    metadata: metadata.payload,
    snapshot: {
      consistent: snapshotIdsMatch(graph.payload, metadata.payload),
      graph: snapshotDescriptorFor(graph.payload),
      metadata: snapshotDescriptorFor(metadata.payload),
    },
    sha: {
      graph: graph.sha,
      metadata: metadata.sha,
    },
  };
}

export async function loadPublishedWorklogsFile() {
  const env = await githubDataConfig();

  if (!env.ok) {
    const error = new Error("GitHub data repository is not configured.");
    error.statusCode = 500;
    error.missing = env.missing;
    throw error;
  }

  const config = env.config;
  const worklogs = await loadJsonFile(config, cacheFilePath(config, "worklogs.json"));

  return {
    status: "hit",
    worklogs: worklogs.payload,
    snapshot: {
      worklogs: snapshotDescriptorFor(worklogs.payload),
    },
    sha: {
      worklogs: worklogs.sha,
    },
  };
}
