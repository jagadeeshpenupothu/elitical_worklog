/* global chrome */

const REQUEST_EVENT = "elitical-worklog-sync:request";
const RESPONSE_EVENT = "elitical-worklog-sync:response";
const READY_EVENT = "elitical-worklog-sync:ready";
const READY_ATTR = "data-elitical-worklog-interceptor";
const BRIDGE_SCRIPT_ID = "elitical-worklog-sync-bridge-fallback";

let bridgeReady = false;
let lastReadyAt = "";

function log(message, details) {
  console.debug("[Content]", message, details || "");
}

function eventTarget() {
  return document.documentElement || document;
}

function markReady() {
  bridgeReady = true;
  lastReadyAt = new Date().toISOString();
  log("Injected interceptor handshake received.", { lastReadyAt });
}

eventTarget().addEventListener(READY_EVENT, markReady);

function detectReadyMarker() {
  if (eventTarget().getAttribute?.(READY_ATTR) === "ready") {
    markReady();
    return true;
  }

  return false;
}

function injectFallbackBridge() {
  if (document.getElementById(BRIDGE_SCRIPT_ID)) return;

  log("Main-world manifest injection not visible; trying script fallback.");

  const script = document.createElement("script");
  script.id = BRIDGE_SCRIPT_ID;
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.onload = () => {
    log("Fallback bridge script loaded.");
    script.remove();
  };
  script.onerror = () => {
    console.error("[Content] Fallback page script injection failed.");
  };
  (document.documentElement || document.head || document).appendChild(script);
}

function requestSnapshot() {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();

    function onResponse(event) {
      if (event.detail?.requestId !== requestId) return;

      eventTarget().removeEventListener(RESPONSE_EVENT, onResponse);
      log("Snapshot received.", event.detail?.diagnostics);
      resolve(event.detail);
    }

    eventTarget().addEventListener(RESPONSE_EVENT, onResponse);
    eventTarget().dispatchEvent(
      new CustomEvent(REQUEST_EVENT, {
        detail: { requestId },
      })
    );

    window.setTimeout(() => {
      eventTarget().removeEventListener(RESPONSE_EVENT, onResponse);
      resolve({
        ok: false,
        error:
          "Page interceptor not responding. Reload the extension, then refresh the Elitical tab once.",
        diagnostics: {
          bridgeReady,
          lastReadyAt,
        },
      });
    }, 1_500);
  });
}

async function latestSnapshot() {
  detectReadyMarker();

  if (!bridgeReady) {
    injectFallbackBridge();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    detectReadyMarker();
  }

  const snapshot = await requestSnapshot();

  if (!snapshot.ok && !bridgeReady) {
    return {
      ...snapshot,
      error:
        "Page script not injected. Reload the extension and refresh Elitical so the interceptor starts before Flutter.",
    };
  }

  return snapshot;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ELITICAL_WORKLOG_GET_CAPTURE") return false;

  latestSnapshot()
    .then(sendResponse)
    .catch((error) => {
      console.error("[Content] Snapshot request failed.", error);
      sendResponse({
        ok: false,
        error: error.message || "Content script failed.",
      });
    });
  return true;
});
