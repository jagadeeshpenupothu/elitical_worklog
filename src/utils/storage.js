import { normalizeSavedState } from "./worklogModel";

const STORAGE_KEY = "jira-flow.story-view";
const STORAGE_VERSION = 1;

export function loadLegacyStoryViewState() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw);

    if (parsed?.version !== STORAGE_VERSION) return null;

    const normalized = normalizeSavedState(parsed.data);

    return normalized.valid ? normalized.state : null;
  } catch {
    return null;
  }
}

export const loadStoryViewState = loadLegacyStoryViewState;
