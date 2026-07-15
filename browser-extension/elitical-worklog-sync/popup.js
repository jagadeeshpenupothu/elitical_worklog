/* global chrome */

const statusEl = document.getElementById("status");
const employeeNameEl = document.getElementById("employeeName");
const projectNameEl = document.getElementById("projectName");
const sprintNameEl = document.getElementById("sprintName");
const hierarchyFoundEl = document.getElementById("hierarchyFound");
const worklogsFoundEl = document.getElementById("worklogsFound");
const lastSyncEl = document.getElementById("lastSync");
const errorEl = document.getElementById("error");
const syncNowButton = document.getElementById("syncNow");
const openWorklogButton = document.getElementById("openWorklog");

function formatDate(value) {
  if (!value) return "Never";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Never";

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function render(state = {}) {
  const status = state.status || "Disconnected";
  const isConnected = status === "Connected";
  const isError = /error|required|failed|expired/i.test(status);
  const hierarchyCount =
    Number(state.counts?.epics || 0) +
    Number(state.counts?.stories || 0) +
    Number(state.counts?.jobs || 0);

  statusEl.textContent = status;
  statusEl.classList.toggle("connected", isConnected);
  statusEl.classList.toggle("error", isError);
  employeeNameEl.textContent =
    state.employee?.name ||
    state.employee?.employeeId ||
    state.employee?.id ||
    "Not connected";
  projectNameEl.textContent = state.project?.name || state.project?.id || "-";
  sprintNameEl.textContent = state.sprint?.name || state.sprint?.id || "-";
  hierarchyFoundEl.textContent = `${hierarchyCount} item${hierarchyCount === 1 ? "" : "s"}`;
  worklogsFoundEl.textContent = `${Number(state.counts?.worklogs || 0)} found`;
  lastSyncEl.textContent = formatDate(state.lastSync);
  errorEl.textContent = state.error || "";
  errorEl.hidden = !state.error;

  if (!state.error && state.diagnostics?.warnings?.length) {
    errorEl.textContent = state.diagnostics.warnings[0];
    errorEl.hidden = false;
  }

  if (!state.error && hierarchyCount === 0 && Number(state.counts?.worklogs || 0) > 0) {
    errorEl.textContent =
      "Only worklogs were captured. Open the Elitical sprint/board page, wait for it to load, then click Sync Now.";
    errorEl.hidden = false;
  }
}

function sendMessage(message) {
  console.debug("[Popup] Sending message.", message.type);
  return chrome.runtime.sendMessage(message);
}

async function refresh() {
  const state = await sendMessage({
    type: "ELITICAL_WORKLOG_GET_STATE",
  });

  console.debug("[Popup] State received.", state);
  render(state);

  const liveCapture = await sendMessage({
    type: "ELITICAL_WORKLOG_READ_CAPTURE",
  });

  console.debug("[Popup] Live capture received.", liveCapture);

  if (liveCapture?.ok) {
    render(liveCapture);
  } else if (liveCapture?.error) {
    render({
      ...state,
      status: "Error",
      error: liveCapture.error,
      diagnostics: liveCapture.diagnostics,
    });
  }
}

syncNowButton.addEventListener("click", async () => {
  console.debug("[Popup] Sync Now clicked.");
  syncNowButton.disabled = true;
  render({ status: "Syncing" });

  const result = await sendMessage({
    type: "ELITICAL_WORKLOG_SYNC_NOW",
  });

  if (!result?.ok) {
    console.error("[Popup] Sync failed.", result);
    render({
      status: "Error",
      error: result?.error || "Sync failed.",
    });
  } else {
    console.debug("[Popup] Sync succeeded.", result);
    render({
      status: "Connected",
      employee: result.employee,
      project: result.project,
      sprint: result.sprint,
      counts: result.counts,
      lastSync: result.lastSync,
      diagnostics: result.diagnostics,
    });
  }

  syncNowButton.disabled = false;
});

openWorklogButton.addEventListener("click", () => {
  console.debug("[Popup] Open Elitical Worklog clicked.");
  sendMessage({
    type: "ELITICAL_OPEN_WORKLOG_PAGE",
  });
});

refresh();
