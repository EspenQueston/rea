import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  bytes,
  intelHexImage,
  intelHexRecord,
  srecImage,
  srecRecord,
} from "../fixtures/firmwareText.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

const expectFileBytes = async (
  path: string,
  expected: Uint8Array,
): Promise<void> => {
  const observed = await readFile(path);
  expect(observed.equals(Buffer.from(expected))).toBe(true);
};

cliTest(
  "inspects and extracts Intel HEX regions through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-hex-cli-");
    const source = join(root, "firmware.hex");
    await writeFile(
      source,
      intelHexImage([
        intelHexRecord(4, 0, bytes(0x08, 0x00)),
        intelHexRecord(0, 0x0000, bytes(0xde, 0xad)),
        intelHexRecord(0, 0x0010, bytes(0xbe, 0xef)),
        intelHexRecord(1, 0),
      ]),
    );
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.manifest.root_format).toBe("intel-hex");
    expect(graph.coverage).toEqual({
      scope: "container-entries",
      status: "complete",
    });
    expect(
      graph.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "intel-hex",
      variant: "i32",
      start_address: null,
      eof_terminated: true,
    });
    expect(
      graph.occurrences
        .filter((row) => row.logical_path !== ".")
        .map((row) => row.logical_path),
    ).toEqual(["0x08000000-0x08000001.bin", "0x08000010-0x08000011.bin"]);
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: root, TMP: root, TEMP: root },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(result.containment_verified).toBe(true);
    await expectFileBytes(
      join(result.output_root, "0x08000000-0x08000001.bin"),
      bytes(0xde, 0xad),
    );
    await expectFileBytes(
      join(result.output_root, "0x08000010-0x08000011.bin"),
      bytes(0xbe, 0xef),
    );
  },
);

cliTest(
  "reports the failing S-record line and preserves unknown coverage",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-srec-cli-");
    const unterminated = join(root, "partial.s19");
    await writeFile(unterminated, srecImage([srecRecord(1, 0x1000, bytes(1))]));
    const incomplete = await cli.run({
      arguments: ["inspect-artifact", unterminated, "--json"],
    });
    expect(incomplete.exitCode, incomplete.stdout + incomplete.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(incomplete.json).normalized_result,
    );
    const graph = artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    );
    expect(graph.coverage.status).toBe("unknown");
    expect(graph.manifest.root_format).toBe("srec");

    const broken = join(root, "broken.s19");
    await writeFile(
      broken,
      srecImage([
        srecRecord(1, 0, bytes(1)),
        srecRecord(5, 2),
        srecRecord(9, 0),
      ]),
    );
    const rejected = await cli.run({
      arguments: ["inspect-artifact", broken, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      code: "artifact_operation_failed",
      details: {
        reason: "format",
        detail: expect.stringContaining("line 2"),
      },
    });
  },
);
