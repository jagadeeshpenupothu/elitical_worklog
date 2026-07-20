import { spawn } from "node:child_process";
import http from "node:http";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronCommand = process.platform === "win32" ? "electron.cmd" : "electron";
const rendererUrl = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5177";
const children = new Map();
let shuttingDown = false;

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  children.set(name, child);

  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown || signal) return;
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });

  return child;
}

function waitForRenderer(url, { timeoutMs = 30000 } = {}) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      const request = http.get(url, (response) => {
        response.resume();

        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }

        retry();
      });

      request.on("error", retry);
      request.setTimeout(1500, () => {
        request.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Vite renderer did not become ready at ${url}`));
        return;
      }

      setTimeout(check, 250);
    }

    check();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    if (!child.killed) child.kill("SIGTERM");
  }

  process.exitCode = code;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("frontend", npmCommand, ["run", "dev:vite"]);

try {
  await waitForRenderer(rendererUrl);
  start("electron", electronCommand, ["."], {
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
    },
  });
} catch (error) {
  console.error(error?.message || error);
  shutdown(1);
}
