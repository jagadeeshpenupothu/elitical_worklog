import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const buildDir = path.join(projectRoot, "build");
const playwrightBuildRoot = path.join(projectRoot, ".playwright-build");
const validArchitectures = new Set(["arm64", "x64"]);

function argumentValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));

  if (index === -1) return "";
  const value = process.argv[index];

  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return process.argv[index + 1] || "";
}

const targetArch = argumentValue("--arch") || process.env.ELITICAL_DMG_ARCH || process.arch;

if (!validArchitectures.has(targetArch)) {
  console.error(
    `[prepare-playwright] Unsupported architecture "${targetArch}". Expected arm64 or x64.`
  );
  process.exit(1);
}

const browserRoot = path.join(playwrightBuildRoot, targetArch, ".local-browsers");
const archiveName = `playwright-browsers-darwin-${targetArch}.tar.gz`;
const archivePath = path.join(buildDir, archiveName);
const hostPlatformOverride = targetArch === "arm64" ? "mac12-arm64" : "mac12";
const expectedChromeDir = targetArch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
const expectedMachO = targetArch === "arm64" ? "arm64" : "x86_64";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += String(data);
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += String(data);
      process.stderr.write(data);
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

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function installedChromiumExecutable() {
  if (!(await pathExists(browserRoot))) return "";

  const entries = await fs.readdir(browserRoot, { withFileTypes: true });
  const chromiumDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
    .map((entry) => path.join(browserRoot, entry.name));

  for (const chromiumDir of chromiumDirs) {
    const candidate = path.join(
      chromiumDir,
      expectedChromeDir,
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    );

    if (await pathExists(candidate)) return candidate;
  }

  return "";
}

async function detectArchitecture(executablePath) {
  const { stdout } = await run("file", [executablePath]);

  if (stdout.includes("arm64")) return "arm64";
  if (stdout.includes("x86_64")) return "x64";
  return "unknown";
}

async function main() {
  console.info("[prepare-playwright] Preparing isolated Playwright Chromium", {
    targetArch,
    nodeArch: process.arch,
    osArch: os.arch(),
    hostPlatformOverride,
    browserRoot: path.relative(projectRoot, browserRoot),
  });

  await fs.rm(path.join(playwrightBuildRoot, targetArch), {
    recursive: true,
    force: true,
  });
  await fs.mkdir(browserRoot, { recursive: true });

  await run("npx", ["playwright", "install", "chromium"], {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browserRoot,
      PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: hostPlatformOverride,
    },
  });

  const chromiumExecutable = await installedChromiumExecutable();

  if (!chromiumExecutable) {
    throw new Error(
      `No ${targetArch} Playwright Chromium executable was found under ${browserRoot}.`
    );
  }

  const architecture = await detectArchitecture(chromiumExecutable);

  if (architecture !== targetArch) {
    throw new Error(
      `Playwright Chromium architecture mismatch: expected ${targetArch}, found ${architecture} at ${chromiumExecutable}.`
    );
  }

  const { stdout: lipoInfo } = await run("lipo", ["-info", chromiumExecutable]).catch(
    () => ({ stdout: "" })
  );

  if (lipoInfo && !lipoInfo.includes(expectedMachO)) {
    throw new Error(
      `Playwright Chromium lipo validation failed: expected ${expectedMachO}, got ${lipoInfo.trim()}.`
    );
  }

  await fs.mkdir(buildDir, { recursive: true });
  await fs.rm(archivePath, { force: true });
  await run("tar", ["-czf", archivePath, ".local-browsers"], {
    cwd: path.join(playwrightBuildRoot, targetArch),
  });

  const stat = await fs.stat(archivePath);

  console.info("[prepare-playwright] Packaged Playwright browsers", {
    archive: path.relative(projectRoot, archivePath),
    chromiumExecutable: path.relative(projectRoot, chromiumExecutable),
    chromiumArchitecture: architecture,
    sizeBytes: stat.size,
  });
}

main().catch((error) => {
  console.error(`[prepare-playwright] ${error?.message || error}`);
  process.exit(1);
});
