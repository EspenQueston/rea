import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import {
  copyExistingGhidraProject,
  fingerprintGhidraProject,
  resolveGhidraProject,
} from "../../../../src/ghidra/GhidraProjectSnapshot.js";
import { parseConfig } from "../../../../src/config/parseConfig.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
});
afterEach(async () => {
  await resources.close();
});
const fixture = async () => {
  const root = await createTestTempDirectory("rea-ghidra-selected-project-");
  const source = join(root, "source");
  const destination = join(root, "runtime", "project");
  await mkdir(join(source, "selected.rep"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(source, "selected.gpr"), "marker");
  await writeFile(join(source, "selected.rep", "data"), "original program");
  return { source, destination };
};

it.skipIf(process.platform === "win32")(
  "copies and fingerprints only the selected project, leaving unrelated siblings untouched",
  async () => {
    const { source, destination } = await fixture();
    await symlink("unrelated-missing-project", join(source, "unrelated.gpr"));
    const commitment = await resolveGhidraProject(
      { path: join(source, "selected.gpr"), programName: "target.elf" },
      "/tmp/target.elf",
      resources,
    );
    await copyExistingGhidraProject(source, destination, {
      projectName: "selected",
      expectedSha256: commitment.sha256,
      resources,
    });
    expect((await readdir(destination)).sort()).toEqual([
      "selected.gpr",
      "selected.rep",
    ]);
    expect(await fingerprintGhidraProject(source, "selected", resources)).toBe(
      commitment.sha256,
    );
    expect(
      await readFile(join(destination, "selected.rep", "data"), "utf8"),
    ).toBe("original program");
  },
);

it("rejects a project whose copied content differs from the committed analysis profile", async () => {
  const { source, destination } = await fixture();
  const original = await fingerprintGhidraProject(
    source,
    "selected",
    resources,
  );
  await writeFile(join(source, "selected.rep", "data"), "modified program");
  expect(
    await fingerprintGhidraProject(source, "selected", resources),
  ).not.toBe(original);
  await expect(
    copyExistingGhidraProject(source, destination, {
      projectName: "selected",
      expectedSha256: original,
      resources,
    }),
  ).rejects.toMatchObject({ name: "RegularFileChangedError" });
});

it("parses an opt-in project once for shared CLI/MCP configuration and rejects import overrides", () => {
  const environment = {
    REA_GHIDRA_PROJECT_PATH: join(process.cwd(), "existing.gpr"),
    REA_GHIDRA_PROGRAM_NAME: "program.elf",
  };
  expect(parseConfig(environment)).toMatchObject({
    ok: true,
    value: {
      ghidraExistingProject: {
        path: environment.REA_GHIDRA_PROJECT_PATH,
        programName: "program.elf",
      },
    },
  });
  for (const extra of [
    { REA_GHIDRA_LANGUAGE_ID: "x86:LE:64:default" },
    { REA_GHIDRA_SEED_FILE: join(process.cwd(), "seeds") },
    { REA_GHIDRA_PROGRAM_NAME: "*" },
  ])
    expect(parseConfig({ ...environment, ...extra }).ok).toBe(false);
  expect(parseConfig({ REA_GHIDRA_PROGRAM_NAME: "program.elf" }).ok).toBe(
    false,
  );
});
