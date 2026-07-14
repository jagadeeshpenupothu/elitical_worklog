import { SNAPSHOT_SCHEMA_VERSION } from "./worklogModel";

const CACHE_KEY = "jira-flow.worklog-cache";
const CACHE_VERSION = 1;

function readCacheRecord() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(CACHE_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (
      parsed?.cacheVersion !== CACHE_VERSION ||
      parsed?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      !parsed.snapshot ||
      typeof parsed.sha !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function loadCache() {
  return readCacheRecord();
}

export function saveCache({ snapshot, sha, lastSyncedAt = new Date().toISOString() }) {
  if (typeof window === "undefined" || !snapshot || typeof sha !== "string") {
    return;
  }

  const record = {
    cacheVersion: CACHE_VERSION,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshot,
    sha,
    lastSyncedAt,
  };

  window.localStorage.setItem(CACHE_KEY, JSON.stringify(record));
}

export function clearCache() {
  if (typeof window === "undefined") return;

  window.localStorage.removeItem(CACHE_KEY);
}

export function getCachedSha() {
  return readCacheRecord()?.sha || "";
}

export function setCachedSha(sha) {
  const record = readCacheRecord();

  if (!record || typeof sha !== "string") return;

  saveCache({
    snapshot: record.snapshot,
    sha,
    lastSyncedAt: record.lastSyncedAt,
  });
}
