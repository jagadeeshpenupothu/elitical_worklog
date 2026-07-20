import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getStoragePaths,
  initializeStorage,
} from "../local-backend/services/StoragePathService.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const APP_NAME = "Elitical Worklog";
const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
const packagedBrowserArchiveName = `playwright-browsers-darwin-${process.arch}.tar.gz`;

let mainWindow = null;
let backendProcess = null;
let backendOrigin = "";
let backendReady = false;
let storagePaths = getStoragePaths();

function appRoot() {
  if (!app.isPackaged) return PROJECT_ROOT;

  return path.join(process.resourcesPath, "app");
}

function resourcePath(...segments) {
  return path.join(appRoot(), ...segments);
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} stopped with signal ${signal}: ${stderr || stdout}`
            : `${command} exited with code ${code}: ${stderr || stdout}`
        )
      );
    });
  });
}

function writeStartupLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;

  if (!app.isReady()) {
    console.error(line.trim());
    return;
  }

  fs.mkdir(storagePaths.logsDir, { recursive: true })
    .then(() => fs.appendFile(storagePaths.startupLogPath, line))
    .catch(() => {});
}

function createSplashHtml(message = "Starting local database...") {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${APP_NAME}</title>
    <style>
      body {
        margin: 0;
        height: 100vh;
        display: grid;
        place-items: center;
        background: #101418;
        color: #f7fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(420px, calc(100vw - 48px));
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
        font-weight: 700;
      }
      p {
        margin: 0;
        color: #b7c1cc;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${APP_NAME}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

function loadSplash(message) {
  mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createSplashHtml(message))}`);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      writeStartupLog(`Selected local backend port: ${port}`);
      server.close(() => resolve(port));
    });
    server.on("error", (error) => {
      writeStartupLog(`Unable to select local backend port: ${error.message}`);
      reject(error);
    });
  });
}

function waitForBackend(origin, { timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();
  let attempts = 0;

  return new Promise((resolve, reject) => {
    function check() {
      attempts += 1;
      const request = http.get(`${origin}/health`, (response) => {
        response.resume();

        if (response.statusCode === 200) {
          writeStartupLog(`Backend health check passed after ${attempts} attempt(s): ${origin}/health`);
          resolve();
          return;
        }

        writeStartupLog(`Backend health check returned ${response.statusCode}; retrying.`);
        retry();
      });

      request.on("error", (error) => {
        if (attempts === 1 || attempts % 10 === 0) {
          writeStartupLog(`Backend health check failed: ${error.message}`);
        }
        retry();
      });
      request.setTimeout(1500, () => {
        request.destroy();
        writeStartupLog("Backend health check timed out; retrying.");
        retry();
      });
    }

    function retry() {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("The local backend did not become ready in time."));
        return;
      }

      setTimeout(check, 250);
    }

    check();
  });
}

async function ensureUserDataFiles() {
  const storageInitialization = await initializeStorage();
  storagePaths = storageInitialization.paths;
  const cacheDir = storagePaths.dataDir;
  const eliticalDataDir = storagePaths.authDir;
  const playwrightBrowsersRoot = storagePaths.playwrightBrowsersRoot;
  const playwrightBrowsersPath = app.isPackaged
    ? storagePaths.playwrightBrowsersPath
    : resourcePath("node_modules", "playwright-core", ".local-browsers");
  const packagedBrowserArchive = path.join(process.resourcesPath, packagedBrowserArchiveName);

  await fs.mkdir(app.isPackaged ? playwrightBrowsersRoot : playwrightBrowsersPath, {
    recursive: true,
  });

  if (app.isPackaged) {
    const entries = await fs.readdir(playwrightBrowsersPath).catch(() => []);
    const hasBrowsers = entries.some((entry) => entry.startsWith("chromium-"));

    if (!hasBrowsers) {
      if (!(await pathExists(packagedBrowserArchive))) {
        throw new Error(`Packaged Playwright browser archive is missing: ${packagedBrowserArchive}`);
      }

      writeStartupLog(`Extracting Playwright browsers from ${packagedBrowserArchive}`);
      await runProcess("tar", ["-xzf", packagedBrowserArchive, "-C", playwrightBrowsersRoot]);
      writeStartupLog("Playwright browsers extracted.");
    }
  }

  writeStartupLog(`Storage root: ${storagePaths.root}`);
  writeStartupLog(`Storage initialization: ${JSON.stringify({
    status: storageInitialization.status,
    rebuildRequired: storageInitialization.rebuildRequired,
    resetDetected: storageInitialization.resetDetected,
    migrated: storageInitialization.migrated,
  })}`);
  writeStartupLog(`Local cache directory: ${cacheDir}`);
  writeStartupLog(`Elitical data directory: ${eliticalDataDir}`);
  writeStartupLog(`Playwright browsers path: ${playwrightBrowsersPath}`);

  return {
    cacheDir,
    eliticalDataDir,
    playwrightBrowsersPath,
    envPath: storagePaths.envPath,
    githubPublicationEnvPath: storagePaths.githubPublicationEnvPath,
    storageStatePath: storagePaths.storageStatePath,
    storageRoot: storagePaths.root,
  };
}

async function startBackend() {
  const port = await findAvailablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {
    cacheDir,
    envPath,
    githubPublicationEnvPath,
    eliticalDataDir,
    playwrightBrowsersPath,
    storageStatePath,
    storageRoot,
  } = await ensureUserDataFiles();
  const electronRunAsNode = process.execPath;
  const tsxCli = resourcePath("node_modules", "tsx", "dist", "cli.mjs");
  const backendEntry = resourcePath("local-backend", "server.mjs");

  backendOrigin = origin;
  backendReady = false;
  writeStartupLog(`Starting backend: ${backendEntry}`);
  writeStartupLog(`Backend launcher: ${electronRunAsNode}`);
  writeStartupLog(`Backend tsx loader: ${tsxCli}`);

  backendProcess = spawn(electronRunAsNode, [tsxCli, backendEntry], {
    cwd: appRoot(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      LOCAL_BACKEND_PORT: String(port),
      ELITICAL_WORKLOG_DATA_ROOT: storageRoot,
      ELITICAL_CACHE_DIR: cacheDir,
      ELITICAL_ENV_PATH: envPath,
      GITHUB_PUBLICATION_ENV_PATH: githubPublicationEnvPath,
      ELITICAL_DESKTOP_PACKAGED: app.isPackaged ? "1" : "0",
      ELITICAL_ALLOW_DEVELOPMENT_ENV_FALLBACK: app.isPackaged ? "0" : "1",
      ELITICAL_SYNC_DIR: storagePaths.syncDir,
      ELITICAL_RUNTIME_DIR: storagePaths.runtimeDir,
      ELITICAL_LOGS_DIR: storagePaths.logsDir,
      ELITICAL_DATA_DIR: eliticalDataDir,
      ELITICAL_STORAGE_STATE_PATH: storageStatePath,
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
    },
    stdio: app.isPackaged ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  writeStartupLog(`Backend process spawned with PID ${backendProcess.pid || "unknown"}.`);

  backendProcess.on("error", (error) => {
    writeStartupLog(`Backend process failed to start: ${error.message}`);
  });

  if (app.isPackaged) {
    backendProcess.stdout?.on("data", (data) => {
      writeStartupLog(`[backend] ${String(data).trimEnd()}`);
    });
    backendProcess.stderr?.on("data", (data) => {
      writeStartupLog(`[backend:error] ${String(data).trimEnd()}`);
    });
  }

  backendProcess.on("exit", (code, signal) => {
    if (app.isQuitting) return;

    const detail = signal
      ? `The backend stopped with signal ${signal}.`
      : `The backend stopped with code ${code}.`;

    writeStartupLog(detail);

    if (backendReady) {
      loadSplash("The local backend stopped unexpectedly.");
      dialog.showErrorBox("Backend stopped", detail);
    }
  });

  await Promise.race([
    waitForBackend(origin),
    new Promise((_, reject) => {
      backendProcess.once("exit", (code, signal) => {
        const detail = signal
          ? `The backend stopped with signal ${signal} before startup completed.`
          : `The backend stopped with code ${code} before startup completed.`;

        reject(new Error(detail));
      });
    }),
  ]);

  backendReady = true;
  return origin;
}

async function loadApplication() {
  loadSplash("Starting local database...");

  try {
    const origin = await startBackend();

    loadSplash("Loading workspace...");
    writeStartupLog(`Loading renderer with backend origin ${origin}.`);

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
      return;
    }

    await mainWindow.loadFile(resourcePath("dist", "index.html"));
  } catch (error) {
    const message = error?.message || "Unable to start the application.";

    writeStartupLog(`Startup failed: ${message}`);
    loadSplash(message);
    dialog.showErrorBox("Startup failed", message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    show: false,
    backgroundColor: "#101418",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  writeStartupLog(`Electron preload path: ${PRELOAD_PATH}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  loadApplication();
}

app.setName(APP_NAME);

process.on("uncaughtException", (error) => {
  const message = error?.stack || error?.message || String(error);

  writeStartupLog(`Uncaught exception: ${message}`);
  dialog.showErrorBox("Startup failed", error?.message || "An unexpected startup error occurred.");
});

process.on("unhandledRejection", (reason) => {
  const message = reason?.stack || reason?.message || String(reason);

  writeStartupLog(`Unhandled rejection: ${message}`);
});

ipcMain.on("elitical:get-backend-url", (event) => {
  writeStartupLog(`Renderer requested backend URL: ${backendOrigin || "(not ready)"}`);
  event.returnValue = backendOrigin;
});

app.whenReady().then(createWindow);

app.on("before-quit", () => {
  app.isQuitting = true;

  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

export function getBackendOrigin() {
  return backendOrigin;
}
