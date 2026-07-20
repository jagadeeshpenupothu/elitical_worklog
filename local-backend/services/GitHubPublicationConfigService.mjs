import fs from "node:fs/promises";
import path from "node:path";
import { getStoragePaths } from "./StoragePathService.mjs";

export const GITHUB_PUBLICATION_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_DATA_OWNER",
  "GITHUB_DATA_REPO",
  "GITHUB_DATA_BRANCH",
  "GITHUB_DATA_PATH",
  "GITHUB_CACHE_PATH",
];

export const REQUIRED_GITHUB_PUBLICATION_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_DATA_OWNER",
  "GITHUB_DATA_REPO",
];

const DEFAULT_GITHUB_DATA_BRANCH = "main";
const DEFAULT_GITHUB_DATA_PATH = "data/worklog.json";

function truthy(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function cleanPath(value = "") {
  return String(value || "")
    .trim()
    .replace(/(ELITICAL_BASE_URL|GITHUB_TOKEN|GITHUB_DATA_OWNER|GITHUB_DATA_REPO|GITHUB_DATA_BRANCH)=.*$/, "")
    .replace(/^\/+/, "");
}

function normalizeEnvValue(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

export function parseEnvContent(raw = "") {
  const parsed = {};

  String(raw || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) return;

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex <= 0) return;

      const key = trimmed.slice(0, separatorIndex).trim();

      if (!GITHUB_PUBLICATION_ENV_KEYS.includes(key)) return;

      parsed[key] = normalizeEnvValue(trimmed.slice(separatorIndex + 1));
    });

  return parsed;
}

function pickPublicationEnv(env = process.env) {
  return GITHUB_PUBLICATION_ENV_KEYS.reduce((picked, key) => {
    if (truthy(env[key])) picked[key] = normalizeEnvValue(env[key]);
    return picked;
  }, {});
}

function developmentFallbackEnabled(env = process.env) {
  return (
    env.ELITICAL_DESKTOP_PACKAGED !== "1" &&
    env.ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK !== "0"
  );
}

function uniqueCandidates(candidates) {
  const seen = new Set();

  return candidates.filter((candidate) => {
    if (!truthy(candidate.path)) return false;

    const resolved = path.resolve(candidate.path);

    if (seen.has(resolved)) return false;

    seen.add(resolved);
    return true;
  });
}

export function githubPublicationConfigPaths(paths = getStoragePaths()) {
  return {
    durableConfigDir: paths.configDir,
    durableConfigPath: paths.githubPublicationEnvPath,
    legacyDurableEnvPath: paths.envPath,
  };
}

export function githubPublicationConfigCandidates({
  env = process.env,
  cwd = process.cwd(),
  paths = getStoragePaths(),
} = {}) {
  const candidates = [
    {
      kind: "explicit-github-publication-env-path",
      path: env.GITHUB_PUBLICATION_ENV_PATH || "",
      explicit: true,
    },
    {
      kind: "explicit-elitical-env-path",
      path: env.ELITICAL_ENV_PATH || "",
      explicit: true,
    },
    {
      kind: "durable-github-publication-config",
      path: paths.githubPublicationEnvPath,
      durable: true,
    },
    {
      kind: "durable-root-env",
      path: paths.envPath,
      durable: true,
    },
  ];

  if (developmentFallbackEnabled(env)) {
    candidates.push({
      kind: "development-repo-env",
      path: path.resolve(cwd, ".env"),
      developmentFallback: true,
    });
  }

  return uniqueCandidates(candidates);
}

async function readEnvFile(filePath) {
  try {
    return {
      loaded: true,
      values: parseEnvContent(await fs.readFile(filePath, "utf8")),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        loaded: false,
        missing: true,
        values: {},
      };
    }

    return {
      loaded: false,
      error: error?.message || "Unable to read config file.",
      values: {},
    };
  }
}

export async function resolveGithubPublicationConfig({
  env = process.env,
  cwd = process.cwd(),
  paths = getStoragePaths(),
} = {}) {
  const values = pickPublicationEnv(env);
  const sources = Object.keys(values).length
    ? [
        {
          kind: "process-env",
          loaded: true,
          keys: Object.keys(values).sort(),
        },
      ]
    : [];

  for (const candidate of githubPublicationConfigCandidates({ env, cwd, paths })) {
    const result = await readEnvFile(candidate.path);
    const keys = Object.keys(result.values).sort();

    for (const key of keys) {
      if (!truthy(values[key])) values[key] = result.values[key];
    }

    sources.push({
      kind: candidate.kind,
      path: candidate.path,
      loaded: result.loaded,
      missing: Boolean(result.missing),
      error: result.error || "",
      keys,
      explicit: Boolean(candidate.explicit),
      durable: Boolean(candidate.durable),
      developmentFallback: Boolean(candidate.developmentFallback),
    });
  }

  const missing = REQUIRED_GITHUB_PUBLICATION_ENV_KEYS.filter((key) => !truthy(values[key]));
  const dataPath = cleanPath(values.GITHUB_DATA_PATH || DEFAULT_GITHUB_DATA_PATH);
  const cacheDir = cleanPath(values.GITHUB_CACHE_PATH || path.posix.dirname(dataPath));
  const config = {
    token: values.GITHUB_TOKEN || "",
    owner: values.GITHUB_DATA_OWNER || "",
    repo: values.GITHUB_DATA_REPO || "",
    branch: values.GITHUB_DATA_BRANCH || DEFAULT_GITHUB_DATA_BRANCH,
    path: dataPath,
    cacheDir,
  };

  return {
    ok: missing.length === 0,
    missing,
    config,
    diagnostics: {
      configured: GITHUB_PUBLICATION_ENV_KEYS.reduce((current, key) => {
        current[key] = truthy(values[key]);
        return current;
      }, {}),
      requiredKeys: [...REQUIRED_GITHUB_PUBLICATION_ENV_KEYS],
      optionalKeys: GITHUB_PUBLICATION_ENV_KEYS.filter(
        (key) => !REQUIRED_GITHUB_PUBLICATION_ENV_KEYS.includes(key)
      ),
      defaults: {
        GITHUB_DATA_BRANCH: !truthy(values.GITHUB_DATA_BRANCH),
        GITHUB_DATA_PATH: !truthy(values.GITHUB_DATA_PATH),
        GITHUB_CACHE_PATH: !truthy(values.GITHUB_CACHE_PATH),
      },
      developmentFallbackEnabled: developmentFallbackEnabled(env),
      durableConfigPath: paths.githubPublicationEnvPath,
      legacyDurableEnvPath: paths.envPath,
      sources,
    },
  };
}

export function githubPublicationReadiness(configResult) {
  return {
    status: configResult.ok ? "configured" : "not-configured",
    configured: configResult.ok,
    missing: configResult.missing,
    requiredKeys: configResult.diagnostics.requiredKeys,
    optionalKeys: configResult.diagnostics.optionalKeys,
    defaults: configResult.diagnostics.defaults,
    durableConfigPath: configResult.diagnostics.durableConfigPath,
    legacyDurableEnvPath: configResult.diagnostics.legacyDurableEnvPath,
    developmentFallbackEnabled: configResult.diagnostics.developmentFallbackEnabled,
    sources: configResult.diagnostics.sources.map((source) => ({
      kind: source.kind,
      path: source.path,
      loaded: source.loaded,
      missing: source.missing,
      error: source.error,
      keys: source.keys,
      explicit: source.explicit,
      durable: source.durable,
      developmentFallback: source.developmentFallback,
    })),
  };
}

export function serializeGithubPublicationEnv(values = {}) {
  const lines = [
    "# Elitical Worklog GitHub publication configuration",
    "# This file lives outside the replaceable app bundle and is not committed.",
  ];

  for (const key of GITHUB_PUBLICATION_ENV_KEYS) {
    if (truthy(values[key])) lines.push(`${key}=${values[key]}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function provisionGithubPublicationConfig({
  sourceEnvPath = path.resolve(process.cwd(), ".env"),
  targetEnvPath = getStoragePaths().githubPublicationEnvPath,
  env = process.env,
} = {}) {
  const sourceValues = {
    ...parseEnvContent(await fs.readFile(sourceEnvPath, "utf8")),
    ...pickPublicationEnv(env),
  };
  const existingRaw = await fs.readFile(targetEnvPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const existingValues = parseEnvContent(existingRaw);
  const existingMissing = REQUIRED_GITHUB_PUBLICATION_ENV_KEYS.filter(
    (key) => !truthy(existingValues[key])
  );

  if (existingMissing.length === 0) {
    await fs.chmod(targetEnvPath, 0o600).catch(() => {});
    return {
      status: "already-configured",
      targetEnvPath,
      copiedKeys: [],
      missing: [],
    };
  }

  const nextValues = { ...existingValues };
  const copiedKeys = [];

  for (const key of GITHUB_PUBLICATION_ENV_KEYS) {
    if (truthy(nextValues[key]) || !truthy(sourceValues[key])) continue;

    nextValues[key] = sourceValues[key];
    copiedKeys.push(key);
  }

  const missing = REQUIRED_GITHUB_PUBLICATION_ENV_KEYS.filter((key) => !truthy(nextValues[key]));

  if (missing.length > 0) {
    const error = new Error("GitHub publication configuration is incomplete.");
    error.missing = missing;
    throw error;
  }

  const nextRaw = serializeGithubPublicationEnv(nextValues);

  await fs.mkdir(path.dirname(targetEnvPath), { recursive: true, mode: 0o700 });

  if (nextRaw !== existingRaw) {
    await fs.writeFile(targetEnvPath, nextRaw, { encoding: "utf8", mode: 0o600 });
  }

  await fs.chmod(targetEnvPath, 0o600).catch(() => {});

  return {
    status: existingRaw ? "completed-existing-updated" : "completed-created",
    targetEnvPath,
    copiedKeys,
    missing: [],
  };
}
