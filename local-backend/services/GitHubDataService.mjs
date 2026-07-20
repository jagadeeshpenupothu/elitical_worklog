import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSnapshotBundle,
  snapshotDescriptorFor,
  snapshotIdsMatch,
} from "./SynchronizedSnapshotService.mjs";

let latestPublicationSequence = 0;

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function hasBase64Content(file) {
  return typeof file?.content === "string" && file.content.trim().length > 0;
}

function encodeBase64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function loadDotEnv() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_DATA_OWNER) return;

  return fs.readFile(process.env.ELITICAL_ENV_PATH || ".env", "utf8")
    .then((raw) => {
      raw.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) return;

        const separatorIndex = trimmed.indexOf("=");

        if (separatorIndex <= 0) return;

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        value = value.replace(/^['"]|['"]$/g, "");

        if (key === "GITHUB_DATA_PATH") {
          value = value.replace(/(ELITICAL_BASE_URL|GITHUB_TOKEN|GITHUB_DATA_OWNER|GITHUB_DATA_REPO|GITHUB_DATA_BRANCH)=.*$/, "");
        }

        if (!process.env[key]) process.env[key] = value;
      });
    })
    .catch(() => {});
}

function cleanPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/(ELITICAL_BASE_URL|GITHUB_TOKEN|GITHUB_DATA_OWNER|GITHUB_DATA_REPO|GITHUB_DATA_BRANCH)=.*$/, "")
    .replace(/^\/+/, "");
}

export function githubDataConfigFromEnv() {
  const basePath = cleanPath(process.env.GITHUB_DATA_PATH || "data/worklog.json");
  const cacheDir = cleanPath(
    process.env.GITHUB_CACHE_PATH ||
      path.posix.dirname(basePath || "data/worklog.json")
  );
  const config = {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_DATA_OWNER,
    repo: process.env.GITHUB_DATA_REPO,
    branch: process.env.GITHUB_DATA_BRANCH || "main",
    path: basePath,
    cacheDir,
  };
  const missing = ["token", "owner", "repo", "branch"].filter((key) => !config[key]);

  return missing.length > 0
    ? { ok: false, missing, config }
    : { ok: true, missing: [], config };
}

export async function githubDataConfig() {
  await loadDotEnv();
  return githubDataConfigFromEnv();
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

export function cacheFilePath(config, fileName) {
  const cacheDir = cleanPath(config.cacheDir || "data");

  return cacheDir ? `${cacheDir}/${fileName}` : fileName;
}

export async function getGitHubFile(config, filePath = config.path) {
  const response = await fetch(
    `${githubFileUrl({ ...config, path: filePath })}?ref=${encodeURIComponent(config.branch)}`,
    {
      headers: githubHeaders(config.token),
    }
  );
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 404) {
      const error = new Error("GitHub data file was not found.");
      error.statusCode = 404;
      throw error;
    }

    const error = new Error(payload?.message || "GitHub load failed.");
    error.statusCode = response.status;
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

  const response = await fetch(file.download_url, {
    headers: githubHeaders(config.token),
  });

  if (!response.ok) {
    const error = new Error("GitHub raw file download failed.");
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
  let current = null;

  try {
    current = await getGitHubFile(config, filePath);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }

  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const response = await fetch(githubFileUrl({ ...config, path: filePath }), {
    method: "PUT",
    headers: {
      ...githubHeaders(config.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: message || `data: update ${filePath}`,
      content: encodeBase64(content),
      ...(current?.sha ? { sha: current.sha } : {}),
      branch: config.branch,
    }),
  });
  const result = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(result?.message || "GitHub save failed.");
    error.statusCode = response.status;
    throw error;
  }

  if (!result?.content?.sha) {
    const error = new Error("GitHub save response was malformed.");
    error.statusCode = 502;
    throw error;
  }

  return {
    path: filePath,
    sha: result.content.sha,
    commitSha: result.commit?.sha || "",
  };
}

export async function publishCacheFiles({
  graph,
  worklogs,
  metadata,
  message = "data: publish Elitical cache",
} = {}) {
  const bundle = assertSnapshotBundle({ graph, worklogs, metadata });
  const descriptor = snapshotDescriptorFor(metadata);
  const sequence = descriptor.syncGenerationSequence || Date.now();

  latestPublicationSequence = Math.max(latestPublicationSequence, sequence);

  const env = await githubDataConfig();

  if (!env.ok) {
    const error = new Error("GitHub data repository is not configured.");
    error.statusCode = 500;
    error.missing = env.missing;
    throw error;
  }

  const config = env.config;
  const files = [
    ["graph.json", graph],
    ["worklogs.json", worklogs],
    ["metadata.json", metadata],
  ];
  const published = [];

  for (const [fileName, payload] of files) {
    if (sequence < latestPublicationSequence) {
      const error = new Error("A newer synchronized snapshot is already being published.");
      error.statusCode = 409;
      error.snapshotId = descriptor.syncGenerationId;
      throw error;
    }

    published.push(
      await putJsonFile(config, cacheFilePath(config, fileName), payload, {
        message,
      })
    );
  }

  return {
    status: "published",
    publishedAt: new Date().toISOString(),
    snapshotId: bundle.snapshotId,
    syncGenerationId: descriptor.syncGenerationId,
    syncGenerationSequence: sequence,
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
