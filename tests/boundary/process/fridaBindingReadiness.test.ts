import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { UpdateCommandRunner } from "../../../src/application/UpdateCommandRunner.js";
import { fridaBindingReadiness } from "../../../src/frida/FridaBindingReadiness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const readinessFixture = async (source?: string) => {
  const root = await createTestTempDirectory("rea-frida-readiness-");
  const packageRoot = join(root, "installed REA 测试");
  const fridaRoot = join(packageRoot, "node_modules", "frida");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "rea-agents", version: "6.8.0" }),
  );
  if (source !== undefined) {
    await mkdir(fridaRoot, { recursive: true });
    await writeFile(
      join(fridaRoot, "package.json"),
      JSON.stringify({
        name: "frida",
        version: "17.23.2",
        type: "module",
        main: "index.js",
        scripts: {
          install:
            "node -e \"require('node:fs').writeFileSync('binding-ready', 'ready')\"",
        },
      }),
    );
    await writeFile(join(fridaRoot, "index.js"), source);
  }
  return { root, packageRoot, fridaRoot };
};

const readySource =
  'export const getDeviceManager = () => { throw new Error("must not enumerate devices"); };';

describe("installed Frida native module readiness", () => {
  it("imports the selected installation afresh without invoking its device manager", async () => {
    const { packageRoot, fridaRoot } = await readinessFixture(readySource);
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toEqual({
      provider: "frida",
      scope: "native-module",
      status: "ready",
    });
    await writeFile(
      join(fridaRoot, "index.js"),
      'throw new Error("replacement binding unavailable");',
    );
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "module-load-failed",
      detail: "Error: replacement binding unavailable",
    });
  });

  it("accepts Frida's CommonJS named-export shape without calling it", async () => {
    const { packageRoot, fridaRoot } = await readinessFixture(
      'exports.getDeviceManager = () => { throw new Error("must not enumerate devices"); };',
    );
    await writeFile(
      join(fridaRoot, "package.json"),
      JSON.stringify({ name: "frida", main: "index.js", type: "commonjs" }),
    );
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("preserves load errors and verifies recovery by explicitly running the scoped install script", async () => {
    const { packageRoot, fridaRoot } = await readinessFixture(
      [
        'import { existsSync } from "node:fs";',
        'if (!existsSync(new URL("binding-ready", import.meta.url))) throw new Error("missing test native binding");',
        readySource,
      ].join("\n"),
    );
    const readiness = await fridaBindingReadiness(
      packageRoot,
      "npm",
      process.env,
    );
    expect(readiness).toMatchObject({
      provider: "frida",
      status: "unavailable",
      reason: "module-load-failed",
      detail: "Error: missing test native binding",
      recovery: {
        command: [
          "npm",
          "--prefix",
          fridaRoot,
          "run",
          "install",
          "--ignore-scripts=false",
        ],
        workingDirectory: packageRoot,
      },
    });
    if (readiness.status === "ready" || readiness.recovery === undefined)
      throw new Error("Expected explicit recovery command.");
    await expect(
      readFile(join(fridaRoot, "binding-ready")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const commands = new UpdateCommandRunner();
    try {
      const repaired = await commands.runInstall(
        readiness.recovery.command,
        process.env,
        "structured",
        readiness.recovery.workingDirectory,
      );
      expect(repaired).toMatchObject({ ok: true });
    } finally {
      await commands.close();
    }
    expect(await readFile(join(fridaRoot, "binding-ready"), "utf8")).toBe(
      "ready",
    );
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toMatchObject({ status: "ready" });
  });
});

describe("Frida resolution and repair ownership", () => {
  it("retains native loader stderr alongside a reported module-load error", async () => {
    const { packageRoot } = await readinessFixture(
      [
        'import { writeSync } from "node:fs";',
        'writeSync(2, "native loader diagnostic\\n");',
        'throw new Error("native binding unavailable");',
      ].join("\n"),
    );
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "module-load-failed",
      detail:
        "Error: native binding unavailable\nstderr:\nnative loader diagnostic\n",
    });
  });

  it("resolves a hoisted dependency and scopes Bun recovery to that package", async () => {
    const { root, packageRoot, fridaRoot } = await readinessFixture(
      'throw new Error("hoisted binding unavailable");',
    );
    const hoistedRoot = join(root, "node_modules", "frida");
    await mkdir(dirname(hoistedRoot), { recursive: true });
    await rename(fridaRoot, hoistedRoot);
    await expect(
      fridaBindingReadiness(packageRoot, "bun", process.env),
    ).resolves.toMatchObject({
      status: "unavailable",
      detail: "Error: hoisted binding unavailable",
      recovery: {
        command: ["bun", "run", "--cwd", hoistedRoot, "install"],
        workingDirectory: packageRoot,
      },
    });
  });

  it("offers no script recovery when the resolved package has no install script", async () => {
    const { packageRoot, fridaRoot } = await readinessFixture(
      'throw new Error("no install script");',
    );
    await writeFile(
      join(fridaRoot, "package.json"),
      JSON.stringify({ name: "frida", main: "index.js", type: "module" }),
    );
    const result = await fridaBindingReadiness(packageRoot, "npm", process.env);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "module-load-failed",
    });
    expect(result).not.toHaveProperty("recovery");
  });

  it("reports an absent optional package without proposing a no-op rebuild", async () => {
    const { packageRoot } = await readinessFixture();
    const result = await fridaBindingReadiness(packageRoot, "npm", process.env);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "dependency-absent",
    });
    expect(result).not.toHaveProperty("recovery");
  });

  it("keeps an unsuccessful probe unknown instead of blaming a missing binding", async () => {
    const { packageRoot } = await readinessFixture("process.exit(2);");
    await expect(
      fridaBindingReadiness(packageRoot, "npm", process.env),
    ).resolves.toMatchObject({ status: "unknown", reason: "probe-failed" });
  });

  it("retains diagnostics when import output prevents interpreting the probe reply", async () => {
    const { packageRoot } = await readinessFixture(
      [
        'console.log("module stdout diagnostic");',
        'console.error("module stderr diagnostic");',
        readySource,
      ].join("\n"),
    );
    const result = await fridaBindingReadiness(packageRoot, "npm", process.env);
    expect(result).toMatchObject({ status: "unknown", reason: "probe-failed" });
    if (result.status === "ready")
      throw new Error("Expected unknown readiness.");
    expect(result.detail).toContain("module stdout diagnostic");
    expect(result.detail).toContain("module stderr diagnostic");
    expect(result).not.toHaveProperty("recovery");
  });
});

const assertStopped = async (pidPath: string) => {
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
};

describe("Frida probe process failure diagnostics", () => {
  it("retains both output streams after the real deadline and waits for exit", async () => {
    const { packageRoot, root, fridaRoot } =
      await readinessFixture(readySource);
    const pidPath = join(root, "timed-out-probe.pid");
    await writeFile(
      join(fridaRoot, "index.js"),
      [
        'import { writeFileSync, writeSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        'writeSync(1, "timeout stdout diagnostic\\n");',
        'writeSync(2, "timeout stderr diagnostic\\n");',
        "setInterval(() => {}, 1000);",
        "await new Promise(() => {});",
      ].join("\n"),
    );
    const readiness = await fridaBindingReadiness(
      packageRoot,
      "npm",
      process.env,
    );
    expect(readiness).toMatchObject({
      status: "unknown",
      reason: "probe-failed",
    });
    if (readiness.status === "ready")
      throw new Error("Expected unknown readiness.");
    expect(readiness.detail).toContain("timed out after 10000 ms");
    expect(readiness.detail).toContain("stdout:\ntimeout stdout diagnostic\n");
    expect(readiness.detail).toContain("stderr:\ntimeout stderr diagnostic\n");
    expect(readiness.detail).toContain('"code":"ETIMEDOUT"');
    expect(readiness.detail).toContain('"killed":true');
    expect(readiness.detail).toContain('"outputTruncated":false');
    expect(readiness).not.toHaveProperty("recovery");
    await assertStopped(pidPath);
  });

  it.each([1, 2])(
    "retains bounded diagnostics when stream %i exceeds the limit",
    async (stream) => {
      const { packageRoot, root, fridaRoot } =
        await readinessFixture(readySource);
      const pidPath = join(root, "output-limited-probe.pid");
      await writeFile(
        join(fridaRoot, "index.js"),
        [
          'import { writeFileSync, writeSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          'writeSync(1, "limit stdout diagnostic\\n");',
          'writeSync(2, "limit stderr diagnostic\\n");',
          `writeSync(${String(stream)}, "x".repeat(128 * 1024));`,
          "setInterval(() => {}, 1000);",
          "await new Promise(() => {});",
        ].join("\n"),
      );
      const readiness = await fridaBindingReadiness(
        packageRoot,
        "npm",
        process.env,
      );
      expect(readiness).toMatchObject({
        status: "unknown",
        reason: "probe-failed",
      });
      if (readiness.status === "ready")
        throw new Error("Expected unknown readiness.");
      expect(readiness.detail).toContain("stdout:\nlimit stdout diagnostic\n");
      expect(readiness.detail).toContain("stderr:\nlimit stderr diagnostic\n");
      expect(readiness.detail).toContain(
        '"code":"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"',
      );
      expect(readiness.detail).toContain('"outputTruncated":true');
      expect(Buffer.byteLength(readiness.detail)).toBeLessThan(
        2 * 64 * 1024 + 8192,
      );
      expect(readiness).not.toHaveProperty("recovery");
      await assertStopped(pidPath);
    },
  );
});
