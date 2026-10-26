/**
 * Repository integrity invariants.
 *
 * These are **general** properties of the repository's sensitive
 * configuration — dependency resolution, install-time execution, and the
 * executable configuration surfaces — not signatures of any one payload. A
 * rule that only recognizes a historical blob would stop working the moment
 * the next one is written, so every rule here states an invariant the
 * repository can keep.
 *
 * The functions are pure: they take already-loaded documents and return the
 * findings, so the same checks run in the CLI and in the conformance suite.
 */

import { parse } from "lossless-json";

/** Lifecycle hooks that run during `npm install`, before any review. */
export const INSTALL_TIME_HOOKS = ["preinstall", "install", "postinstall"];

/** The public registry every locked package must resolve against. */
export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/**
 * The configuration surfaces that execute during install, build, test, or CI.
 *
 * The list is owned here so the CLI and the conformance suite read the same
 * surfaces: a rule applied to a surface only one of them knows about would be
 * a rule one of them never runs.
 */
export const CONFIGURATION_SURFACES = [
  { path: "package.json", kind: "script" },
  { path: ".npmrc", kind: "shell" },
  { path: "turbo.json", kind: "script" },
  { path: "knip.json", kind: "script" },
  { path: ".oxfmtrc.json", kind: "script" },
  { path: ".oxlintrc.json", kind: "script" },
  { path: ".jscpd.json", kind: "script" },
  { path: "release-please-config.json", kind: "script" },
  { path: ".release-please-manifest.json", kind: "script" },
  { path: "tsconfig.json", kind: "script" },
  { path: "tsconfig.build.json", kind: "script" },
  { path: "tsconfig.frida-verification.json", kind: "script" },
  { path: "tsconfig.reverse-tools-mutation.json", kind: "script" },
  { path: "install.sh", kind: "shell" },
  { path: "vitest.config.ts", kind: "script" },
  { path: "vitest.reverse-tools.config.ts", kind: "script" },
  { path: "vitest.reverse-tools-semantics.config.ts", kind: "script" },
  { path: "stryker.config.mjs", kind: "script" },
  { path: "stryker.semantics.config.mjs", kind: "script" },
  { path: ".husky/pre-commit", kind: "shell" },
  { path: ".husky/pre-push", kind: "shell" },
  { path: "scripts/prepare.mjs", kind: "script" },
  { path: "scripts/prepack.mjs", kind: "script" },
  { path: "scripts/check-dependency-install.mjs", kind: "script" },
  { path: "scripts/run-exclusive.mjs", kind: "script" },
  { path: "scripts/run-exclusive-command.mjs", kind: "script" },
];

/** An exact version, with an optional prerelease or build suffix. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** An npm alias to an exact version (`npm:<name>@<version>`). */
const ALIASED_EXACT_VERSION =
  /^npm:[^@\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** A decode step that turns an opaque literal into executable source. */
const DECODE_STEP =
  /atob\s*\(|fromCharCode|Buffer\.from\s*\([^)]*base64|unescape\s*\(|decodeURIComponent\s*\(/u;

/** `eval` or `new Function`, the two ways source text becomes code. */
const DYNAMIC_EVALUATION = /\beval\b|\bnew\s+Function\b/u;

/** How many lines above an evaluation a decode may be bound. */
const DECODE_WINDOW = 4;

/** A base64 run long enough to carry a payload rather than a value. */
const OPAQUE_BASE64 = /[A-Za-z0-9+/]{200,}={0,2}/u;

/** A hex run long enough to carry a payload rather than a digest fragment. */
const OPAQUE_HEX = /\b[0-9a-fA-F]{120,}\b/u;

/** Remote content piped straight into an interpreter. */
const REMOTE_SCRIPT_EXECUTION =
  /curl[^|\n]*\|\s*(?:ba)?sh|wget[^|\n]*\|\s*(?:ba)?sh|Invoke-WebRequest[^|\n]*\|\s*Invoke-Expression|<\(\s*curl/u;

/** A third-party action reference, in `owner/repo@ref` form. */
const ACTION_REFERENCE = /^[^/\s]+\/[^@\s]+@(?<ref>\S+)$/u;

/** A commit-pinned action reference. */
const PINNED_ACTION_REFERENCE = /^[0-9a-f]{40}$/u;

/**
 * Report the install-time lifecycle hooks a package manifest declares.
 *
 * An install-time hook executes on every `npm install`, before a reviewer can
 * read the change and before the repository's own gates run. The repository
 * removed its own `postinstall` for that reason, so the absence is a decision
 * worth keeping enforceable.
 */
export const findInstallTimeHooks = (scripts) =>
  INSTALL_TIME_HOOKS.filter(
    (name) => typeof scripts?.[name] === "string",
  ).sort();

/**
 * Report the locked packages whose install script is not an explicit
 * decision.
 *
 * `package.json#allowScripts` is the repository's install-script policy: a
 * package listed there is either approved (`true`) or denied (`false`), and a
 * package that is absent is *undecided* — npm then warns on every install and
 * the policy is not actually enforced.
 */
export const findUndecidedInstallScripts = (lockPackages, allowScripts) => {
  const decided = new Set(Object.keys(allowScripts ?? {}));
  const undecided = [];
  for (const [path, meta] of Object.entries(lockPackages ?? {})) {
    if (path === "" || meta?.hasInstallScript !== true) continue;
    const name = path.slice(
      path.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    const version = meta.version;
    if (typeof version !== "string") continue;
    if (decided.has(`${name}@${version}`) || decided.has(name)) continue;
    undecided.push(`${name}@${version}`);
  }
  return [...new Set(undecided)].sort();
};

/**
 * Report the direct dependencies that are not exact public-registry versions.
 *
 * An exact version cannot silently become a different artifact, and a
 * registry-qualified specifier cannot arrive from an arbitrary location. An
 * npm alias to an exact version is accepted: the alias names a package, the
 * version stays pinned.
 */
export const findUnpinnedDirectDependencies = (packageJson) => {
  const findings = [];
  const groups = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  for (const group of groups) {
    for (const [name, spec] of Object.entries(packageJson?.[group] ?? {})) {
      if (typeof spec !== "string") continue;
      if (EXACT_VERSION.test(spec) || ALIASED_EXACT_VERSION.test(spec))
        continue;
      findings.push(`${group}.${name} = ${spec}`);
    }
  }
  for (const [name, override] of Object.entries(packageJson?.overrides ?? {})) {
    const specs =
      typeof override === "string" ? [override] : Object.values(override ?? {});
    for (const spec of specs) {
      if (typeof spec !== "string") continue;
      if (EXACT_VERSION.test(spec) || ALIASED_EXACT_VERSION.test(spec))
        continue;
      findings.push(`overrides.${name} = ${spec}`);
    }
  }
  return findings.sort();
};

/**
 * Report the locked packages that do not resolve from the public registry with
 * an integrity hash.
 *
 * A resolved URL that is not the public registry, or a resolved package with
 * no integrity hash, means the artifact a reviewer approved and the artifact
 * an installer fetches are not provably the same bytes.
 */
export const findUnresolvedLockEntries = (lockPackages) => {
  const findings = [];
  for (const [path, meta] of Object.entries(lockPackages ?? {})) {
    if (path === "" || meta?.link === true) continue;
    if (typeof meta?.version !== "string") continue;
    if (typeof meta.resolved !== "string") {
      findings.push(`${path}: no resolved registry URL`);
      continue;
    }
    if (!meta.resolved.startsWith(PUBLIC_REGISTRY)) {
      findings.push(`${path}: resolves outside ${PUBLIC_REGISTRY}`);
      continue;
    }
    if (typeof meta.integrity !== "string") {
      findings.push(`${path}: no integrity hash`);
    }
  }
  return findings.sort();
};

/**
 * Report the tracked JSON documents that carry a duplicate key.
 *
 * A duplicate key is not an error in `JSON.parse`: the last value silently
 * wins, so two tools can read the same file and disagree about its content.
 * The canonical writer already rejects duplicate keys, and the repository's
 * own configuration should not be weaker than the payloads it writes.
 */
export const findDuplicateJsonKeys = (documents) => {
  const findings = [];
  for (const { path, text } of documents) {
    const duplicates = [];
    try {
      parse(text, undefined, {
        onDuplicateKey: (info) => {
          duplicates.push(info.key);
        },
      });
    } catch (cause) {
      findings.push(`${path}: not valid JSON (${cause?.message ?? cause})`);
      continue;
    }
    for (const key of [...new Set(duplicates)].sort()) {
      findings.push(`${path}: duplicate key ${JSON.stringify(key)}`);
    }
  }
  return findings.sort();
};

/**
 * Remove comments so a rule reads executable text rather than prose.
 *
 * A configuration file may *describe* a pattern it forbids — the installer
 * documents its own `curl ... | bash` truncation guard in a comment — and a
 * rule that matched the prose would report the documentation as the defect.
 */
export const stripComments = (text, kind) => {
  if (kind === "shell" || kind === "yaml") {
    return text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  }
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
};

/**
 * Report the executable configuration documents that break an invariant.
 *
 * The rules are properties of the configuration, not of one payload:
 *
 * - `decoded-evaluation` — source text that is decoded and then evaluated;
 * - `opaque-literal` — a literal long enough to carry a payload;
 * - `remote-script-execution` — remote content piped into an interpreter;
 * - `unpinned-action` — a third-party action that is not pinned to a commit.
 */
export const findConfigurationViolations = (documents) => {
  const findings = [];
  for (const { path, text, kind = "script" } of documents) {
    const executable = stripComments(text, kind);
    const lines = executable.split("\n");
    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (DYNAMIC_EVALUATION.test(line)) {
        // The decoded value is usually bound on one of the lines above the
        // evaluation, so the pairing is a window rather than a single line.
        const window = lines
          .slice(Math.max(0, index - DECODE_WINDOW + 1), index + 1)
          .join("\n");
        if (DECODE_STEP.test(window)) {
          findings.push(`${path}:${lineNumber}: decoded-evaluation`);
        }
      }
      if (OPAQUE_BASE64.test(line) || OPAQUE_HEX.test(line)) {
        findings.push(`${path}:${lineNumber}: opaque-literal`);
      }
      if (REMOTE_SCRIPT_EXECUTION.test(line)) {
        findings.push(`${path}:${lineNumber}: remote-script-execution`);
      }
      for (const match of line.matchAll(/\buses:\s*(\S+)/gu)) {
        const reference = ACTION_REFERENCE.exec(match[1]);
        if (reference === null) continue;
        if (!PINNED_ACTION_REFERENCE.test(reference.groups.ref)) {
          findings.push(`${path}:${lineNumber}: unpinned-action ${match[1]}`);
        }
      }
    }
  }
  return findings.sort();
};
