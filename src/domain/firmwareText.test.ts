import { describe, expect, it } from "vitest";

import {
  FirmwareTextParseError,
  parseFirmwareText,
  type FirmwareTextFormat,
  type FirmwareTextLine,
} from "./firmwareText.js";
import {
  bytes,
  intelHexImage,
  intelHexRecord,
  srecImage,
  srecRecord,
} from "../../tests/fixtures/firmwareText.js";

const linesFrom = (image: Buffer): readonly FirmwareTextLine[] =>
  image
    .toString("ascii")
    .split(/\r?\n/u)
    .map((text, index) => ({
      number: index + 1,
      bytes: Buffer.from(text, "ascii"),
    }));

const parse = (format: FirmwareTextFormat, image: Buffer) =>
  parseFirmwareText(
    format,
    (async function* () {
      yield* linesFrom(image);
    })(),
  );

const parseError = async (
  format: FirmwareTextFormat,
  image: Buffer,
): Promise<FirmwareTextParseError> => {
  try {
    await parse(format, image);
  } catch (cause: unknown) {
    if (cause instanceof FirmwareTextParseError) return cause;
    throw cause;
  }
  throw new Error("Expected a firmware text parse failure");
};

describe("parseFirmwareText Intel HEX", () => {
  it("decodes sparse I8 records without zero-filling gaps", async () => {
    const image = intelHexImage([
      intelHexRecord(0, 0x0000, bytes(0xaa, 0xbb)),
      intelHexRecord(0, 0x0010, bytes(0xcc)),
      intelHexRecord(1, 0),
    ]);
    const parsed = await parse("intel-hex", image);
    expect(parsed.metadata).toMatchObject({
      kind: "intel-hex",
      variant: "i8",
      start_address: null,
      eof_terminated: true,
      records: { data: 2, end_of_file: 1 },
    });
    expect(parsed.regions).toEqual([
      { startAddress: 0, endAddress: 1, bytes: bytes(0xaa, 0xbb) },
      { startAddress: 0x10, endAddress: 0x10, bytes: bytes(0xcc) },
    ]);
  });

  it("derives I16 segment addresses and a segment-offset start address", async () => {
    const image = intelHexImage([
      intelHexRecord(2, 0, bytes(0x10, 0x00)),
      intelHexRecord(0, 0x0010, bytes(0x11)),
      intelHexRecord(3, 0, bytes(0x12, 0x34, 0x56, 0x78)),
      intelHexRecord(1, 0),
    ]);
    const parsed = await parse("intel-hex", image);
    expect(parsed.metadata).toMatchObject({
      variant: "i16",
      start_address: 0x179b8,
      start_address_source: "record-03",
      start_segment: 0x1234,
      start_offset: 0x5678,
    });
    expect(parsed.regions[0]).toMatchObject({
      startAddress: 0x10010,
      endAddress: 0x10010,
    });
  });

  it("derives I32 linear addresses and a start linear address", async () => {
    const image = intelHexImage([
      intelHexRecord(4, 0, bytes(0x08, 0x00)),
      intelHexRecord(0, 0x0000, bytes(0xde, 0xad)),
      intelHexRecord(5, 0, bytes(0x08, 0x00, 0x01, 0x01)),
      intelHexRecord(1, 0),
    ]);
    const parsed = await parse("intel-hex", image);
    expect(parsed.metadata).toMatchObject({
      variant: "i32",
      start_address: 0x0800_0101,
      start_address_source: "record-05",
    });
    expect(parsed.regions[0]).toMatchObject({
      startAddress: 0x0800_0000,
      endAddress: 0x0800_0001,
    });
  });

  it("merges contiguous records and accepts identical overlap", async () => {
    const image = intelHexImage([
      intelHexRecord(0, 0x0000, bytes(1, 2, 3, 4)),
      intelHexRecord(0, 0x0002, bytes(3, 4, 5, 6)),
      intelHexRecord(1, 0),
    ]);
    const parsed = await parse("intel-hex", image);
    expect(parsed.regions).toEqual([
      {
        startAddress: 0,
        endAddress: 5,
        bytes: bytes(1, 2, 3, 4, 5, 6),
      },
    ]);
  });

  it("fails closed on conflicting overlap with the line number", async () => {
    const error = await parseError(
      "intel-hex",
      intelHexImage([
        intelHexRecord(0, 0x0000, bytes(1, 2)),
        intelHexRecord(0, 0x0001, bytes(9)),
        intelHexRecord(1, 0),
      ]),
    );
    expect(error.reason).toBe("format");
    expect(error.line).toBe(2);
    expect(error.message).toContain("conflicting overlap");
  });

  it("fails closed on checksum and unknown record types", async () => {
    const checksum = await parseError(
      "intel-hex",
      intelHexImage([":01000000AABB", intelHexRecord(1, 0)]),
    );
    expect(checksum.line).toBe(1);
    expect(checksum.message).toContain("checksum mismatch");

    const unknown = await parseError(
      "intel-hex",
      intelHexImage([intelHexRecord(6, 0, bytes(1)), intelHexRecord(1, 0)]),
    );
    expect(unknown.line).toBe(1);
    expect(unknown.message).toContain("unknown record type 0x06");
  });

  it("fails closed on conflicting address modes and start addresses", async () => {
    const modes = await parseError(
      "intel-hex",
      intelHexImage([
        intelHexRecord(2, 0, bytes(0, 0)),
        intelHexRecord(4, 0, bytes(0, 0)),
        intelHexRecord(1, 0),
      ]),
    );
    expect(modes.line).toBe(2);
    expect(modes.message).toContain("conflicts with an extended segment");

    const start = await parseError(
      "intel-hex",
      intelHexImage([
        intelHexRecord(5, 0, bytes(0, 0, 0, 1)),
        intelHexRecord(5, 0, bytes(0, 0, 0, 2)),
        intelHexRecord(1, 0),
      ]),
    );
    expect(start.line).toBe(2);
    expect(start.message).toContain("conflicts with the earlier");
  });

  it("leaves coverage unknown when the EOF record is missing", async () => {
    const parsed = await parse(
      "intel-hex",
      intelHexImage([intelHexRecord(0, 0, bytes(1))]),
    );
    expect(parsed.metadata).toMatchObject({ eof_terminated: false });
    expect(parsed.regions).toHaveLength(1);
  });
});

describe("parseFirmwareText Motorola S-record", () => {
  it("decodes S19 with an S0 header, S5 count, and S9 termination", async () => {
    const image = srecImage([
      srecRecord(0, 0, Buffer.from("build-42", "ascii")),
      srecRecord(1, 0x1000, bytes(0xaa, 0xbb)),
      srecRecord(1, 0x1004, bytes(0xcc)),
      srecRecord(5, 2),
      srecRecord(9, 0x1000),
    ]);
    const parsed = await parse("srec", image);
    expect(parsed.metadata).toMatchObject({
      kind: "srec",
      variant: "s19",
      start_address: 0x1000,
      start_address_source: "s9",
      s0_header: "build-42",
      s0_header_hex: Buffer.from("build-42").toString("hex"),
      terminated: true,
      records: { s0: 1, s1: 2, s5: 1, s9: 1 },
    });
    expect(parsed.regions).toEqual([
      { startAddress: 0x1000, endAddress: 0x1001, bytes: bytes(0xaa, 0xbb) },
      { startAddress: 0x1004, endAddress: 0x1004, bytes: bytes(0xcc) },
    ]);
  });

  it("decodes S28 and S37 address widths", async () => {
    const s28 = await parse(
      "srec",
      srecImage([
        srecRecord(2, 0x12_3456, bytes(1)),
        srecRecord(5, 1),
        srecRecord(8, 0x12_3456),
      ]),
    );
    expect(s28.metadata).toMatchObject({
      variant: "s28",
      start_address: 0x12_3456,
      start_address_source: "s8",
    });

    const s37 = await parse(
      "srec",
      srecImage([
        srecRecord(3, 0x1234_5678, bytes(2)),
        srecRecord(6, 1),
        srecRecord(7, 0x1234_5678),
      ]),
    );
    expect(s37.metadata).toMatchObject({
      variant: "s37",
      start_address: 0x1234_5678,
      start_address_source: "s7",
    });
  });

  it("fails closed on count, checksum, unknown type, and duplicate termination", async () => {
    const count = await parseError(
      "srec",
      srecImage([
        srecRecord(1, 0, bytes(1)),
        srecRecord(5, 2),
        srecRecord(9, 0),
      ]),
    );
    expect(count.line).toBe(2);
    expect(count.message).toContain("observed 1");

    const checksum = await parseError(
      "srec",
      srecImage(["S9030000FB", srecRecord(9, 0)]),
    );
    expect(checksum.line).toBe(1);
    expect(checksum.message).toContain("checksum mismatch");

    const unknown = await parseError("srec", srecImage([srecRecord(4, 0)]));
    expect(unknown.line).toBe(1);
    expect(unknown.message).toContain("unknown or reserved record type S4");

    const duplicate = await parseError(
      "srec",
      srecImage([srecRecord(9, 0), srecRecord(9, 0)]),
    );
    expect(duplicate.line).toBe(2);
    expect(duplicate.message).toContain("follows the termination record");
  });

  it("leaves coverage unknown when the termination record is missing", async () => {
    const parsed = await parse("srec", srecImage([srecRecord(1, 0, bytes(1))]));
    expect(parsed.metadata).toMatchObject({ terminated: false });
    expect(parsed.regions).toHaveLength(1);
  });
});
