import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import {
  scanArtifactInventory,
  materializeArtifactInventory,
} from "../../fixtures/artifactInventory.js";
import {
  bytes,
  intelHexImage,
  intelHexRecord,
  srecImage,
  srecRecord,
} from "../../fixtures/firmwareText.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const expectFileBytes = async (
  path: string,
  expected: Uint8Array,
): Promise<void> => {
  const observed = await readFile(path);
  expect(observed.equals(Buffer.from(expected))).toBe(true);
};

describe("firmware text artifacts", () => {
  it("classifies, inventories, hashes, and extracts Intel HEX regions", async () => {
    const root = await createTestTempDirectory("rea-intel-hex-");
    const source = join(root, "firmware.hex");
    const image = intelHexImage([
      intelHexRecord(4, 0, bytes(0x08, 0x00)),
      intelHexRecord(0, 0x0000, bytes(0xde, 0xad, 0xbe, 0xef)),
      intelHexRecord(0, 0x0010, bytes(0x01, 0x02)),
      intelHexRecord(5, 0, bytes(0x08, 0x00, 0x00, 0x00)),
      intelHexRecord(1, 0),
    ]);
    await writeFile(source, image);

    expect(await parseBinaryTarget(source)).toMatchObject({
      ok: true,
      value: { kind: "artifact", format: "intel-hex" },
    });

    const snapshot = await scanArtifactInventory(source);
    expect(snapshot.manifest.root_format).toBe("intel-hex");
    expect(snapshot.coverage).toEqual({
      scope: "container-entries",
      status: "complete",
    });
    const rootRow = snapshot.occurrences.find(
      (row) => row.logical_path === ".",
    );
    expect(rootRow?.format_metadata).toMatchObject({
      kind: "intel-hex",
      variant: "i32",
      start_address: 0x0800_0000,
      eof_terminated: true,
    });
    const first = snapshot.occurrences.find(
      (row) => row.logical_path === "0x08000000-0x08000003.bin",
    );
    const second = snapshot.occurrences.find(
      (row) => row.logical_path === "0x08000010-0x08000011.bin",
    );
    expect(first).toMatchObject({
      artifact_format: "file",
      declared_size: 4,
      format_metadata: {
        kind: "intel-hex-region",
        start_address: 0x0800_0000,
        end_address: 0x0800_0003,
      },
      hash_status: "verified",
    });
    expect(second).toMatchObject({ declared_size: 2 });
    const firstNode = snapshot.nodes.find(
      (row) => row.artifact_id === first?.artifact_id,
    );
    expect(firstNode?.sha256).toBe(sha256(bytes(0xde, 0xad, 0xbe, 0xef)));

    const outputRoot = join(root, "out");
    await materializeArtifactInventory(
      {
        inputPath: source,
        inputFormat: "intel-hex",
        outputRoot,
        environment: {},
        integrityPolicy: "fail",
      },
      source,
      snapshot,
    );
    await expectFileBytes(
      join(outputRoot, "0x08000000-0x08000003.bin"),
      bytes(0xde, 0xad, 0xbe, 0xef),
    );
    await expectFileBytes(
      join(outputRoot, "0x08000010-0x08000011.bin"),
      bytes(1, 2),
    );
  });

  it("inventories and extracts S-record regions with S0 facts", async () => {
    const root = await createTestTempDirectory("rea-srec-");
    const source = join(root, "vehicle.s37");
    await writeFile(
      source,
      srecImage([
        srecRecord(0, 0, Buffer.from("ecu-7", "ascii")),
        srecRecord(3, 0x1234_5600, bytes(0xaa, 0xbb)),
        srecRecord(5, 1),
        srecRecord(7, 0x1234_5600),
      ]),
    );

    expect(await parseBinaryTarget(source)).toMatchObject({
      ok: true,
      value: { kind: "artifact", format: "srec" },
    });
    const snapshot = await scanArtifactInventory(source);
    expect(snapshot.manifest.root_format).toBe("srec");
    expect(snapshot.coverage).toEqual({
      scope: "container-entries",
      status: "complete",
    });
    expect(
      snapshot.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "srec",
      variant: "s37",
      start_address: 0x1234_5600,
      s0_header: "ecu-7",
      terminated: true,
    });
    expect(
      snapshot.occurrences.find(
        (row) => row.logical_path === "0x12345600-0x12345601.bin",
      ),
    ).toMatchObject({
      artifact_format: "file",
      format_metadata: {
        kind: "srec-region",
        start_address: 0x1234_5600,
        end_address: 0x1234_5601,
      },
    });

    const outputRoot = join(root, "out");
    await materializeArtifactInventory(
      {
        inputPath: source,
        inputFormat: "srec",
        outputRoot,
        environment: {},
        integrityPolicy: "fail",
      },
      source,
      snapshot,
    );
    await expectFileBytes(
      join(outputRoot, "0x12345600-0x12345601.bin"),
      bytes(0xaa, 0xbb),
    );
  });
});

describe("firmware text failures", () => {
  it("reports unknown coverage when the termination record is absent", async () => {
    const root = await createTestTempDirectory("rea-hex-unterminated-");
    const source = join(root, "partial.hex");
    await writeFile(source, intelHexImage([intelHexRecord(0, 0, bytes(0xaa))]));
    const snapshot = await scanArtifactInventory(source);
    expect(snapshot.coverage).toEqual({
      scope: "container-entries",
      status: "unknown",
    });
    expect(snapshot.limitations.join(" ")).toContain("no end-of-file record");
  });

  it("fails closed with the source line for malformed records", async () => {
    const root = await createTestTempDirectory("rea-hex-invalid-");
    const source = join(root, "broken.hex");
    await writeFile(
      source,
      intelHexImage([
        intelHexRecord(0, 0, bytes(1, 2)),
        intelHexRecord(0, 1, bytes(9)),
        intelHexRecord(1, 0),
      ]),
    );
    await expect(scanArtifactInventory(source)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining("line 2: conflicting overlap"),
    });
  });

  it("keeps an ELF named .hex on the executable route", async () => {
    const root = await createTestTempDirectory("rea-hex-elf-");
    const source = join(root, "not-really.hex");
    await writeFile(
      source,
      Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0]),
        Buffer.alloc(64),
      ]),
    );
    expect(await parseBinaryTarget(source)).toMatchObject({
      ok: false,
      error: { constraint: "file_format_rejected" },
    });
  });
});
