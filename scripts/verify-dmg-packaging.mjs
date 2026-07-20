import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const packageLockPath = path.join(projectRoot, "package-lock.json");
const buildDmgPath = path.join(projectRoot, "scripts", "build-dmg.mjs");
const validArchitectures = new Set(["arm64", "x64"]);

function argumentValue(name) {
  const prefix = `${name}=`;
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));

  if (index === -1) return "";
  const value = process.argv[index];

  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return process.argv[index + 1] || "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function pathExists(filePath) {
  return fs.existsSync(filePath);
}

function plistValue(plistPath, key) {
  return execFileSync("plutil", ["-extract", key, "raw", plistPath], {
    encoding: "utf8",
  }).trim();
}

function occurrenceCount(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

function verifyNpmVersionPatchKeepsLockSynchronized() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elitical-dmg-version-"));

  try {
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "elitical-version-fixture",
          version: "0.0.0",
          private: true,
        },
        null,
        2
      )}\n`
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "elitical-version-fixture",
          version: "0.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "elitical-version-fixture",
              version: "0.0.0",
            },
          },
        },
        null,
        2
      )}\n`
    );

    execFileSync("npm", ["version", "patch", "--no-git-tag-version"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const bumpedPackage = readJson(path.join(fixtureRoot, "package.json"));
    const bumpedLock = readJson(path.join(fixtureRoot, "package-lock.json"));

    assert.equal(bumpedPackage.version, "0.0.1", "npm version patch bumps fixture package once");
    assert.equal(bumpedLock.version, "0.0.1", "npm version patch synchronizes fixture package-lock root");
    assert.equal(
      bumpedLock.packages[""].version,
      "0.0.1",
      "npm version patch synchronizes fixture package-lock package metadata"
    );
    assert.equal(
      pathExists(path.join(fixtureRoot, ".git")),
      false,
      "fixture version bump creates no git repository or git metadata"
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

const targetArch = argumentValue("--arch");

if (targetArch && !validArchitectures.has(targetArch)) {
  throw new Error(`Unsupported --arch "${targetArch}". Expected arm64 or x64.`);
}

const packageJson = readJson(packageJsonPath);
const packageLock = readJson(packageLockPath);
const buildDmgSource = fs.readFileSync(buildDmgPath, "utf8");
const packageVersion = String(packageJson.version || "");
const rootLockPackage = packageLock.packages?.[""] || {};
const bumpCommand = "npm version patch --no-git-tag-version";
const currentArm64Command = "npm run build && npm run prepare:playwright:arm64 && node scripts/build-dmg.mjs --arch arm64";
const currentX64Command = "npm run build && npm run prepare:playwright:x64 && node scripts/build-dmg.mjs --arch x64";

assert.match(packageVersion, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "package.json version is valid");
assert.equal(packageLock.version, packageVersion, "package-lock root version matches package.json");
assert.equal(rootLockPackage.version, packageVersion, "package-lock packages[\"\"] version matches package.json");

assert.equal(
  packageJson.scripts["build:dmg:current:arm64"],
  currentArm64Command,
  "internal ARM64 build rebuilds current version without version bump"
);
assert.equal(
  packageJson.scripts["build:dmg:current:x64"],
  currentX64Command,
  "internal x64 build rebuilds current version without version bump"
);
assert.equal(
  packageJson.scripts["build:dmg:arm64"],
  `${bumpCommand} && npm run build:dmg:current:arm64`,
  "public ARM64 build bumps patch once and invokes only ARM64 internal build"
);
assert.equal(
  packageJson.scripts["build:dmg:x64"],
  `${bumpCommand} && npm run build:dmg:current:x64`,
  "public x64 build bumps patch once and invokes only x64 internal build"
);
assert.equal(
  packageJson.scripts["build:dmg"],
  `${bumpCommand} && npm run build:dmg:current:arm64 && npm run build:dmg:current:x64`,
  "combined public build bumps patch once before both internal architecture builds"
);
assert.equal(packageJson.scripts["release:dmg"], "npm run build:dmg", "release:dmg is an alias for the normal public build");
assert.equal(occurrenceCount(packageJson.scripts["build:dmg:arm64"], /npm version/g), 1, "ARM64 build bumps exactly once");
assert.equal(occurrenceCount(packageJson.scripts["build:dmg:x64"], /npm version/g), 1, "x64 build bumps exactly once");
assert.equal(occurrenceCount(packageJson.scripts["build:dmg"], /npm version/g), 1, "combined build bumps exactly once");
assert.equal(occurrenceCount(packageJson.scripts["release:dmg"], /npm version/g), 0, "release alias does not add a second bump");
assert.doesNotMatch(packageJson.scripts["build:dmg:current:arm64"], /npm version/, "internal ARM64 build does not bump version");
assert.doesNotMatch(packageJson.scripts["build:dmg:current:x64"], /npm version/, "internal x64 build does not bump version");
assert.doesNotMatch(
  packageJson.scripts["build:dmg"],
  /build:dmg:arm64|build:dmg:x64/,
  "combined build uses no-bump internal architecture builds"
);
for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
  if (scriptName.includes("dmg")) {
    assert.doesNotMatch(command, /git\s+(tag|commit|push)/, `${scriptName} performs no git actions`);
  }
}
verifyNpmVersionPatchKeepsLockSynchronized();

assert.doesNotMatch(buildDmgSource, /const\s+version\s*=\s*["']0\.0\.0["']/, "build-dmg does not hard-code 0.0.0");
assert.match(buildDmgSource, /readPackageVersion/, "build-dmg reads package.json version");
assert.match(buildDmgSource, /CFBundleShortVersionString[\s\S]*version/, "build-dmg writes CFBundleShortVersionString from package version");
assert.match(buildDmgSource, /CFBundleVersion[\s\S]*version/, "build-dmg writes CFBundleVersion from package version");
assert.match(buildDmgSource, /Duplicate raw Playwright browser payload/, "build-dmg validates duplicate browser payload absence");
assert.match(buildDmgSource, /Temporary browser audit directory/, "build-dmg validates .browser-audit absence");
assert.doesNotMatch(
  buildDmgSource,
  /electron-builder returned a non-zero status[\s\S]*continuing/,
  "build-dmg does not broadly continue after electron-builder failure"
);
assert.match(buildDmgSource, /\.builder-\$\{targetArch\}/, "build-dmg uses architecture-isolated builder output");
assert.match(buildDmgSource, /mac-x64/, "build-dmg uses a deterministic x64 final output directory");
assert.match(buildDmgSource, /await fs\.rm\(dmgPath/, "same-version rebuild may replace the exact DMG artifact");
assert.doesNotMatch(buildDmgSource, /fs\.rm\(releaseDir/, "build-dmg does not delete previous versioned DMGs");

const files = packageJson.build?.files || [];
assert.ok(
  files.includes("!node_modules/playwright-core/.local-browsers/**"),
  "electron-builder excludes playwright-core raw browser payload"
);
assert.ok(
  files.includes("!node_modules/playwright/.local-browsers/**"),
  "electron-builder excludes playwright raw browser payload if present"
);

if (targetArch) {
  const finalDir = targetArch === "arm64" ? "mac-arm64" : "mac-x64";
  const appPath = path.join(projectRoot, "release", finalDir, "Elitical Worklog.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const appResourcesPath = path.join(resourcesPath, "app");
  const browserArchivePath = path.join(resourcesPath, `playwright-browsers-darwin-${targetArch}.tar.gz`);
  const rawBrowserPath = path.join(
    appResourcesPath,
    "node_modules",
    "playwright-core",
    ".local-browsers"
  );
  const dmgPath = path.join(projectRoot, "release", `Elitical Worklog-${packageVersion}-${targetArch}.dmg`);
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const frameworkPath = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Libraries"
  );

  assert.ok(pathExists(appPath), `packaged ${targetArch} app exists`);
  assert.ok(pathExists(dmgPath), `${targetArch} DMG filename matches package version`);
  assert.ok(pathExists(path.join(appResourcesPath, "node_modules", "playwright", "package.json")), "Playwright JS package remains");
  assert.ok(pathExists(path.join(appResourcesPath, "node_modules", "playwright-core", "package.json")), "Playwright Core JS package remains");
  assert.equal(pathExists(rawBrowserPath), false, "raw playwright-core/.local-browsers is absent from final app");
  assert.equal(pathExists(path.join(resourcesPath, ".browser-audit")), false, ".browser-audit is absent from final app");
  assert.ok(pathExists(browserArchivePath), "architecture-specific browser archive remains packaged");
  assert.ok(pathExists(frameworkPath), "Electron Framework Libraries symlink resolves");
  assert.equal(plistValue(plistPath, "CFBundleShortVersionString"), packageVersion);
  assert.equal(plistValue(plistPath, "CFBundleVersion"), packageVersion);
}

console.log(
  targetArch
    ? `DMG packaging verification PASS (${targetArch})`
    : "DMG packaging verification PASS"
);
