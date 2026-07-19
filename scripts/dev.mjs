import { spawn } from "node:child_process";
import readline from "node:readline";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = new Map();
let shuttingDown = false;

const services = [
  {
    name: "backend",
    color: "\x1b[36m",
    args: ["run", "backend:local"],
  },
  {
    name: "frontend",
    color: "\x1b[35m",
    args: ["run", "dev:netlify"],
  },
];

function prefix(service, line, stream = process.stdout) {
  const reset = "\x1b[0m";
  stream.write(`${service.color}[${service.name}]${reset} ${line}\n`);
}

function pipeLines(service, readable, stream) {
  const lines = readline.createInterface({
    input: readable,
    crlfDelay: Infinity,
  });

  lines.on("line", (line) => prefix(service, line, stream));
}

function terminateProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      process.stderr.write(`[dev] Failed to stop process group ${child.pid}: ${error.message}\n`);
    }
  }
}

function shutdown(exitCode = 0, reason = "shutdown") {
  if (shuttingDown) return;

  shuttingDown = true;
  process.stdout.write(`[dev] Stopping services (${reason})...\n`);

  for (const child of children.values()) {
    terminateProcess(child, "SIGTERM");
  }

  const forceTimer = setTimeout(() => {
    for (const child of children.values()) {
      terminateProcess(child, "SIGKILL");
    }
  }, 5_000);

  forceTimer.unref();

  const waitForExit = setInterval(() => {
    const running = [...children.values()].some(
      (child) => child.exitCode === null && !child.signalCode
    );

    if (running) return;

    clearInterval(waitForExit);
    clearTimeout(forceTimer);
    process.exit(exitCode);
  }, 100);
}

for (const service of services) {
  const child = spawn(npmCommand, service.args, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      FORCE_COLOR: process.env.FORCE_COLOR || "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.set(service.name, child);
  prefix(service, `started: npm ${service.args.join(" ")}`);
  pipeLines(service, child.stdout, process.stdout);
  pipeLines(service, child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    children.delete(service.name);

    if (shuttingDown) return;

    const exitCode = code ?? (signal ? 1 : 0);
    process.stderr.write(
      `[dev] ${service.name} exited with ${signal || `code ${exitCode}`}.\n`
    );
    shutdown(exitCode || 1, `${service.name} exited`);
  });
}

process.on("SIGINT", () => shutdown(130, "Ctrl+C"));
process.on("SIGTERM", () => shutdown(143, "SIGTERM"));
process.on("uncaughtException", (error) => {
  process.stderr.write(`[dev] ${error.stack || error.message}\n`);
  shutdown(1, "uncaught exception");
});
