const SESSION_STORAGE_KEY = "elitical.session";
const DEFAULT_LOGIN_URL = "https://elitical.sayukth.com/auth/login";

function canUseStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") return null;

  return {
    token: String(session.token || ""),
    authorization: String(session.authorization || ""),
    sJwtToken: String(session.sJwtToken || session.sJWTToken || ""),
    sessionId: String(session.sessionId || ""),
    employeeId: String(session.employeeId || ""),
    projectId: String(session.projectId || ""),
    authenticatedAt: String(session.authenticatedAt || ""),
  };
}

export function getStoredSession() {
  if (!canUseStorage()) return null;

  try {
    return normalizeSession(
      JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY))
    );
  } catch {
    return null;
  }
}

export function setStoredSession(session) {
  if (!canUseStorage()) return null;

  const normalized = normalizeSession(session);

  if (!normalized) return null;

  window.localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify(normalized)
  );

  return normalized;
}

export function clearStoredSession() {
  if (!canUseStorage()) return;

  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export function getEliticalLoginUrl(returnUrl = window.location.href) {
  const configuredUrl =
    import.meta.env.VITE_ELITICAL_LOGIN_URL || DEFAULT_LOGIN_URL;
  const url = new URL(configuredUrl, window.location.origin);

  if (import.meta.env.VITE_ELITICAL_LOGIN_RETURN_PARAM) {
    url.searchParams.set(
      import.meta.env.VITE_ELITICAL_LOGIN_RETURN_PARAM,
      returnUrl
    );
  }

  return url.toString();
}

export function extractSessionFromUrl(url = window.location.href) {
  if (import.meta.env.VITE_ELITICAL_ENABLE_CALLBACK_IMPORT !== "true") {
    return null;
  }

  const parsed = new URL(url);
  const token = parsed.searchParams.get("eliticalToken");
  const authorization = parsed.searchParams.get("eliticalAuthorization");
  const sJwtToken = parsed.searchParams.get("eliticalSJwtToken");
  const sessionId = parsed.searchParams.get("eliticalSessionId");

  if (!token && !authorization && !sJwtToken && !sessionId) return null;

  return normalizeSession({
    token,
    authorization,
    sJwtToken,
    sessionId,
    employeeId: parsed.searchParams.get("eliticalEmployeeId"),
    projectId: parsed.searchParams.get("eliticalProjectId"),
    authenticatedAt: new Date().toISOString(),
  });
}

export function consumeSessionFromUrl() {
  if (typeof window === "undefined") return null;

  const session = extractSessionFromUrl();

  if (!session) return null;

  setStoredSession(session);

  const url = new URL(window.location.href);
  [
    "eliticalToken",
    "eliticalAuthorization",
    "eliticalSJwtToken",
    "eliticalSessionId",
    "eliticalEmployeeId",
    "eliticalProjectId",
  ].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", url.toString());

  return session;
}

export function authHeaders(session = getStoredSession()) {
  const normalized = normalizeSession(session);
  const headers = {};

  if (!normalized) return headers;
  if (normalized.authorization) headers.Authorization = normalized.authorization;
  else if (normalized.token) headers.Authorization = `Bearer ${normalized.token}`;
  if (normalized.sJwtToken) headers["s-jwt-token"] = normalized.sJwtToken;
  if (normalized.sessionId) headers["X-Elitical-Session-Id"] = normalized.sessionId;
  if (normalized.employeeId) headers["X-Elitical-Employee-Id"] = normalized.employeeId;
  if (normalized.projectId) headers["X-Elitical-Project-Id"] = normalized.projectId;

  return headers;
}
