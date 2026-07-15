/* global chrome */

const ELITICAL_ORIGIN = "https://elitical.sayukth.com";
const DEFAULT_WORKLOG_ENDPOINT =
  "http://localhost:8888/api/elitical/extension-sync";
const DEFAULT_WORKLOG_URL = "http://localhost:5173";
const ELITICAL_WORKLOG_URL = `${ELITICAL_ORIGIN}/worklog/summary/view`;

async function getSettings() {
  const settings = await chrome.storage.local.get({
    worklogEndpoint: DEFAULT_WORKLOG_ENDPOINT,
    worklogUrl: DEFAULT_WORKLOG_URL,
    lastSync: null,
    employee: null,
    project: null,
    sprint: null,
    counts: null,
    status: "Disconnected",
    error: "",
    diagnostics: null,
  });

  if (settings.status === "Connected" && !settings.employee?.id) {
    return {
      ...settings,
      status: "Disconnected",
      error: "Connected state was reset because no employee data was captured.",
      employee: null,
      project: null,
      sprint: null,
      counts: null,
      lastSync: null,
    };
  }

  return settings;
}

async function saveStatus(patch) {
  await chrome.storage.local.set({
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

async function findEliticalTab() {
  console.debug("[Background] Looking for an Elitical tab.");
  const tabs = await chrome.tabs.query({ url: `${ELITICAL_ORIGIN}/*` });

  return tabs.find((tab) => tab.id) || null;
}

async function ensureEliticalTab() {
  const existing = await findEliticalTab();

  if (existing) return existing;

  console.debug("[Background] No Elitical tab found; opening login page.");
  return chrome.tabs.create({
    url: `${ELITICAL_ORIGIN}/auth/login`,
    active: true,
  });
}

async function openEliticalWorklog() {
  const tab = await ensureEliticalTab();

  if (!tab?.id) return null;

  await chrome.tabs.update(tab.id, {
    url: ELITICAL_WORKLOG_URL,
    active: true,
  });

  return tab;
}

async function sendToContent(tabId, message) {
  try {
    console.debug("[Background] Sending message to content script.", message.type);
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    console.debug("[Background] Content script not ready; injecting it.");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function postToWorklog(payload) {
  const { worklogEndpoint } = await getSettings();
  console.debug("[Background] Posting normalized payload to Worklog.", {
    endpoint: worklogEndpoint,
    employeeId: payload?.employee?.id,
    counts: payload?.counts,
  });
  const response = await fetch(worklogEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worklog-Extension": "elitical-phase1",
    },
    body: JSON.stringify(payload),
  });
  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      responseBody?.message ||
        responseBody?.error ||
        `Worklog rejected sync (${response.status})`
    );
  }

  return responseBody;
}

async function runSync() {
  console.debug("[Background] Sync requested.");
  await saveStatus({ status: "Syncing", error: "" });

  const tab = await ensureEliticalTab();

  if (!tab?.id) {
    throw new Error("Unable to open Elitical tab.");
  }

  const data = await sendToContent(tab.id, {
    type: "ELITICAL_WORKLOG_GET_CAPTURE",
  });

  if (!data?.ok) {
    console.warn("[Background] Capture was not ready.", data);
    await saveStatus({
      status: "Error",
      error: data?.error || "Elitical capture is not ready.",
      diagnostics: data?.diagnostics || null,
    });
    throw new Error(data?.error || "Elitical sync failed.");
  }

  const hierarchyCount =
    Number(data.payload?.counts?.epics || 0) +
    Number(data.payload?.counts?.stories || 0) +
    Number(data.payload?.counts?.jobs || 0);

  if (hierarchyCount === 0) {
    const message =
      "Only worklogs were captured. Open the Elitical sprint/board page, wait for it to load, then click Sync Now again.";

    await saveStatus({
      status: "Action Required",
      error: message,
      employee: data.payload?.employee || null,
      project: data.payload?.project || null,
      sprint: data.payload?.sprint || null,
      counts: data.payload?.counts || null,
      diagnostics: data.diagnostics || null,
    });

    throw new Error(message);
  }

  const accepted = await postToWorklog(data.payload);
  const employee = data.payload?.employee || null;
  const project = data.payload?.project || null;
  const sprint = data.payload?.sprint || null;
  const counts = data.payload?.counts || null;
  const lastSync = data.payload?.syncedAt || new Date().toISOString();

  await saveStatus({
    status: "Connected",
    error: "",
    employee,
    project,
    sprint,
    counts,
    lastSync,
    accepted,
    diagnostics: data.diagnostics || null,
  });

  console.debug("[Background] Sync completed.", {
    employee,
    project,
    sprint,
    counts,
  });

  return {
    ok: true,
    employee,
    project,
    sprint,
    counts,
    lastSync,
    accepted,
    diagnostics: data.diagnostics || null,
  };
}

async function readCaptureState() {
  const tab = await findEliticalTab();

  if (!tab?.id) {
    return {
      ok: false,
      error: "No Elitical tab is open. Open elitical.sayukth.com first.",
    };
  }

  const data = await sendToContent(tab.id, {
    type: "ELITICAL_WORKLOG_GET_CAPTURE",
  });

  if (!data?.ok) {
    await saveStatus({
      status: "Error",
      error: data?.error || "Unable to read captured Elitical data.",
      diagnostics: data?.diagnostics || null,
    });
    return data;
  }

  const payload = data.payload || {};
  const state = {
    status: "Captured",
    error: "",
    employee: payload.employee || null,
    project: payload.project || null,
    sprint: payload.sprint || null,
    counts: payload.counts || null,
    diagnostics: data.diagnostics || null,
  };

  await saveStatus(state);

  return {
    ok: true,
    ...state,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ELITICAL_WORKLOG_GET_STATE") {
    console.debug("[Background] Popup requested state.");
    getSettings().then(sendResponse);
    return true;
  }

  if (message?.type === "ELITICAL_WORKLOG_SYNC_NOW") {
    runSync()
      .then(sendResponse)
      .catch(async (error) => {
        const isAuthError = /auth|login|session|401|403/i.test(error.message);

        console.error("[Background] Sync failed.", error);
        await saveStatus({
          status: isAuthError ? "Authentication Required" : "Error",
          error: error.message || "Sync failed.",
        });

        sendResponse({
          ok: false,
          error: error.message || "Sync failed.",
        });
      });
    return true;
  }

  if (message?.type === "ELITICAL_WORKLOG_READ_CAPTURE") {
    readCaptureState()
      .then(sendResponse)
      .catch((error) => {
        console.error("[Background] Capture read failed.", error);
        sendResponse({
          ok: false,
          error: error.message || "Unable to read captured Elitical data.",
        });
      });
    return true;
  }

  if (message?.type === "ELITICAL_WORKLOG_OPEN_APP") {
    console.debug("[Background] Opening Worklog app.");
    getSettings()
      .then(({ worklogUrl }) => chrome.tabs.create({ url: worklogUrl }))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ELITICAL_OPEN_WORKLOG_PAGE") {
    openEliticalWorklog()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
