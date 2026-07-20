import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(projectRoot, "release");
const productName = "Elitical Worklog";
const validArchitectures = new Set(["arm64", "x64"]);

async function readPackageVersion() {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8")
  );
  const version = String(packageJson.version || "").trim();

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version is not a valid release version: ${version || "(empty)"}`);
  }

  return version;
}

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
  console.error(`[build-dmg] Unsupported architecture "${targetArch}". Expected arm64 or x64.`);
  process.exit(1);
}

const version = await readPackageVersion();
const builderOutputDir = path.join(releaseDir, `.builder-${targetArch}`);
const builderAppOutDir = path.join(builderOutputDir, targetArch === "arm64" ? "mac-arm64" : "mac");
const appOutDir = path.join(releaseDir, targetArch === "arm64" ? "mac-arm64" : "mac-x64");
const productAppPath = path.join(appOutDir, `${productName}.app`);
const builderElectronAppPath = path.join(builderAppOutDir, "Electron.app");
const builderProductAppPath = path.join(builderAppOutDir, `${productName}.app`);
const dmgPath = path.join(releaseDir, `${productName}-${version}-${targetArch}.dmg`);
const browserArchiveName = `playwright-browsers-darwin-${targetArch}.tar.gz`;
const browserArchive = path.join(projectRoot, "build", browserArchiveName);
const expectedMachO = targetArch === "arm64" ? "arm64" : "x86_64";
const expectedChromeDir = targetArch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64";
const rawBrowserPayloadPath = path.join(
  productAppPath,
  "Contents",
  "Resources",
  "app",
  "node_modules",
  "playwright-core",
  ".local-browsers"
);
const auditRoot = path.join(productAppPath, "Contents", "Resources", ".browser-audit");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
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

async function assertPath(filePath, label) {
  if (!(await pathExists(filePath))) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

async function assertFile(filePath, label) {
  await assertPath(filePath, label);
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
}

async function assertDirectory(filePath, label) {
  await assertPath(filePath, label);
  const stat = await fs.stat(filePath);

  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${filePath}`);
  }
}

async function assertAbsent(filePath, label) {
  if (await pathExists(filePath)) {
    throw new Error(`${label} must not exist in the packaged app: ${filePath}`);
  }
}

async function assertMachOArchitecture(filePath, label) {
  const { stdout } = await run("file", [filePath]);

  if (!stdout.includes(expectedMachO)) {
    throw new Error(
      `${label} architecture mismatch for ${targetArch}: expected ${expectedMachO}, got ${stdout.trim()}.`
    );
  }

  console.info(`[build-dmg] ${label} architecture verified`, {
    targetArch,
    file: path.relative(projectRoot, filePath),
    fileOutput: stdout.trim(),
  });
}

async function packagedExecutablePath() {
  const candidates = [
    path.join(productAppPath, "Contents", "MacOS", productName),
    path.join(productAppPath, "Contents", "MacOS", "Electron"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  return candidates[0];
}

async function findPackagedChromiumExecutable() {
  const browsersRoot = path.join(
    productAppPath,
    "Contents",
    "Resources",
    ".browser-audit",
    ".local-browsers"
  );
  const entries = await fs.readdir(browsersRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue;

    const candidate = path.join(
      browsersRoot,
      entry.name,
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

async function packageApp() {
  await fs.rm(builderOutputDir, { recursive: true, force: true });
  await fs.rm(appOutDir, { recursive: true, force: true });

  await run("npx", [
    "electron-builder",
    "--mac",
    "dir",
    `--${targetArch}`,
    `--config.directories.output=${path.relative(projectRoot, builderOutputDir)}`,
  ]);

  const builtAppPath = (await pathExists(builderProductAppPath))
    ? builderProductAppPath
    : builderElectronAppPath;

  if (!(await pathExists(builtAppPath))) {
    throw new Error(`electron-builder did not produce an app bundle for ${targetArch}.`);
  }

  await fs.mkdir(appOutDir, { recursive: true });
  await fs.rename(builtAppPath, productAppPath);
  await assertFile(await packagedExecutablePath(), "Packaged Electron executable");
  await fs.rm(builderOutputDir, { recursive: true, force: true });
}

async function finishResources() {
  await assertFile(browserArchive, "Packaged Playwright browser archive");

  const resourcesDir = path.join(productAppPath, "Contents", "Resources");

  await fs.copyFile(browserArchive, path.join(resourcesDir, browserArchiveName));

  const plistPath = path.join(productAppPath, "Contents", "Info.plist");

  await run("plutil", ["-replace", "CFBundleName", "-string", productName, plistPath]);
  await run("plutil", [
    "-replace",
    "CFBundleDisplayName",
    "-string",
    productName,
    plistPath,
  ]);
  await run("plutil", [
    "-replace",
    "CFBundleIdentifier",
    "-string",
    "com.elitical.worklog",
    plistPath,
  ]);
  await run("plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    version,
    plistPath,
  ]);
  await run("plutil", [
    "-replace",
    "CFBundleVersion",
    "-string",
    version,
    plistPath,
  ]);
}

async function pruneDuplicateBrowserPayload() {
  if (!(await pathExists(rawBrowserPayloadPath))) return;

  await fs.rm(rawBrowserPayloadPath, { recursive: true, force: true });
  console.info("[build-dmg] Removed duplicate raw Playwright browser payload", {
    path: path.relative(projectRoot, rawBrowserPayloadPath),
  });
}

async function validateFrameworkSymlinks() {
  const frameworkRoot = path.join(
    productAppPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework"
  );

  await assertDirectory(frameworkRoot, "Electron Framework");

  const requiredFrameworkPaths = [
    path.join(frameworkRoot, "Versions", "Current"),
    path.join(frameworkRoot, "Electron Framework"),
    path.join(frameworkRoot, "Libraries"),
    path.join(frameworkRoot, "Resources"),
    path.join(frameworkRoot, "Versions", "Current", "Electron Framework"),
    path.join(frameworkRoot, "Versions", "Current", "Libraries"),
    path.join(frameworkRoot, "Versions", "Current", "Resources"),
  ];

  for (const requiredPath of requiredFrameworkPaths) {
    await assertPath(requiredPath, `Required framework path ${path.relative(projectRoot, requiredPath)}`);
    await fs.realpath(requiredPath);
  }
}

async function validatePlistVersion() {
  const plistPath = path.join(productAppPath, "Contents", "Info.plist");
  const { stdout: shortVersion } = await run("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    plistPath,
  ]);
  const { stdout: bundleVersion } = await run("plutil", [
    "-extract",
    "CFBundleVersion",
    "raw",
    plistPath,
  ]);

  if (shortVersion.trim() !== version) {
    throw new Error(`CFBundleShortVersionString mismatch: expected ${version}, got ${shortVersion.trim()}.`);
  }

  if (bundleVersion.trim() !== version) {
    throw new Error(`CFBundleVersion mismatch: expected ${version}, got ${bundleVersion.trim()}.`);
  }
}

async function validatePackagedApp() {
  await assertDirectory(productAppPath, "Packaged app");
  await assertDirectory(path.join(productAppPath, "Contents", "Resources"), "Packaged Resources directory");
  await assertDirectory(path.join(productAppPath, "Contents", "Resources", "app"), "Packaged application resources");
  await assertFile(
    path.join(productAppPath, "Contents", "Resources", "app", "node_modules", "playwright", "package.json"),
    "Playwright package"
  );
  await assertFile(
    path.join(productAppPath, "Contents", "Resources", "app", "node_modules", "playwright-core", "package.json"),
    "Playwright Core package"
  );
  await assertFile(
    path.join(productAppPath, "Contents", "Resources", browserArchiveName),
    "Packaged Playwright browser archive"
  );
  await assertAbsent(rawBrowserPayloadPath, "Duplicate raw Playwright browser payload");
  await assertAbsent(auditRoot, "Temporary browser audit directory");
  await validateFrameworkSymlinks();
  await validatePlistVersion();
  await assertMachOArchitecture(await packagedExecutablePath(), "Electron executable");

  try {
    await fs.rm(auditRoot, { recursive: true, force: true });
    await fs.mkdir(auditRoot, { recursive: true });
    await run("tar", ["-xzf", path.join(productAppPath, "Contents", "Resources", browserArchiveName), "-C", auditRoot]);

    const chromiumExecutable = await findPackagedChromiumExecutable();

    if (!chromiumExecutable) {
      throw new Error(
        `Packaged Playwright Chromium executable for ${targetArch} was not found inside ${browserArchiveName}.`
      );
    }

    await assertMachOArchitecture(chromiumExecutable, "Playwright Chromium executable");
  } finally {
    await fs.rm(auditRoot, { recursive: true, force: true });
  }

  await assertAbsent(auditRoot, "Temporary browser audit directory");
}

async function createDmg() {
  await fs.rm(dmgPath, { force: true });
  await run("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    productAppPath,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);

  const stat = await fs.stat(dmgPath);

  console.info("[build-dmg] Created DMG", {
    arch: targetArch,
    app: path.relative(projectRoot, productAppPath),
    dmg: path.relative(projectRoot, dmgPath),
    sizeBytes: stat.size,
  });
}

async function main() {
  await packageApp();
  await pruneDuplicateBrowserPayload();
  await finishResources();
  await validatePackagedApp();
  await createDmg();
}

main().catch((error) => {
  console.error(`[build-dmg] ${error?.message || error}`);
  process.exit(1);
});
