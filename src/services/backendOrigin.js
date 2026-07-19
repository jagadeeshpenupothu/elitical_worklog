const DEFAULT_LOCAL_BACKEND_ORIGIN = "http://127.0.0.1:3797";

export function localBackendOrigin() {
  const desktopBackendUrl =
    typeof window !== "undefined"
      ? window.eliticalDesktop?.getBackendUrl?.() || window.eliticalDesktop?.backendUrl
      : "";

  if (desktopBackendUrl) return desktopBackendUrl;

  if (typeof window !== "undefined" && window.eliticalDesktop?.isDesktop) {
    throw new Error("Desktop backend is not ready. Please restart Elitical Worklog.");
  }

  if (import.meta.env.VITE_LOCAL_BACKEND_URL) {
    return import.meta.env.VITE_LOCAL_BACKEND_URL;
  }

  return DEFAULT_LOCAL_BACKEND_ORIGIN;
}
