#!/usr/bin/env node

/**
 * Verify the repository's sensitive configuration invariants.
 *
 * The checks are general properties of the dependency graph and of the
 * executable configuration surfaces — see `scripts/lib/repository-integrity.mjs`
 * for the rules and for why each one is a property rather than a signature.
 *
 * The gate is read-only: it reads the working tree and the Git index, and it
 * never installs, builds, or executes the configuration it inspects.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  CONFIGURATION_SURFACES,
  findConfigurationViolations,
  findDuplicateJsonKeys,
  findInstallTimeHooks,
  findUndecidedInstallScripts,
  findUnpinnedDirectDependencies,
  findUnresolvedLockEntries,
} from "./lib/repository-integrity.mjs";

const root = resolve(import.meta.dirname, "..");

const readText = async (relative) => {
  try {
    return await readFile(join(root, relative), "utf8");
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
};

const readJson = async (relative) => JSON.parse(await readText(relative));

const listFiles = (patterns) =>
  execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...patterns,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();

const findings = [];

const packageJson = await readJson("package.json");
const lockfile = await readJson("package-lock.json");

for (const hook of findInstallTimeHooks(packageJson.scripts)) {
  findings.push(
    `package.json: defines the install-time lifecycle hook \`${hook}\``,
  );
}

for (const pending of findUndecidedInstallScripts(
  lockfile.packages,
  packageJson.allowScripts,
)) {
  findings.push(
    `package.json: ${pending} has an install script that \`allowScripts\` does not decide`,
  );
}

for (const unpinned of findUnpinnedDirectDependencies(packageJson)) {
  findings.push(
    `package.json: ${unpinned} is not an exact public-registry version`,
  );
}

for (const unresolved of findUnresolvedLockEntries(lockfile.packages)) {
  findings.push(`package-lock.json: ${unresolved}`);
}

const jsonDocuments = [];
for (const relative of listFiles(["*.json"])) {
  const text = await readText(relative);
  if (text === undefined) continue;
  jsonDocuments.push({ path: relative, text });
}
for (const duplicate of findDuplicateJsonKeys(jsonDocuments)) {
  findings.push(duplicate);
}

const configurationDocuments = [];
const workflowFiles = listFiles([
  ".github/workflows/*.yml",
  ".github/actions/*/action.yml",
]);
for (const surface of [
  ...CONFIGURATION_SURFACES,
  ...workflowFiles.map((path) => ({ path, kind: "yaml" })),
]) {
  const text = await readText(surface.path);
  if (text === undefined) continue;
  configurationDocuments.push({ path: surface.path, text, kind: surface.kind });
}
for (const violation of findConfigurationViolations(configurationDocuments)) {
  findings.push(violation);
}

if (findings.length > 0) {
  console.error(
    `Repository integrity check failed with ${findings.length} finding(s):`,
  );
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `Repository integrity check passed (${jsonDocuments.length} JSON documents, ${configurationDocuments.length} configuration surfaces).`,
  );
}
