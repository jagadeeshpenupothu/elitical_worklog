# Elitical Worklog Sync Extension

Manifest V3 extension for Chrome and Brave.

## Load Locally

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `browser-extension/elitical-worklog-sync`.

## Use

1. Start the Worklog app through Netlify dev so the receive endpoint exists:
   `netlify dev`
2. Sign in normally at `https://elitical.sayukth.com`.
3. Refresh the Elitical tab once so the extension can install its interceptors
   before Flutter loads.
4. Open the extension popup.
5. Click Sync Now.

The extension injects a page script at `document_start`, monkey-patches
`fetch` and `XMLHttpRequest`, and records sanitized `/api/1/` JSON responses.
It reuses the authenticated Elitical page session. It does not ask for
credentials and does not store or send cookies, tokens, passwords, or
authorization headers.

## Data Sent To Worklog

The extension sends only normalized JSON to:

`http://localhost:8888/api/elitical/extension-sync`

Included data:

- authenticated employee profile
- current project
- current sprint
- assigned epics
- assigned stories
- assigned jobs
- authenticated employee worklogs

Authentication tokens and cookies are never included in the payload.
