import { crc32 } from "node:zlib";

import { err, ok, type Result } from "../../domain/result.js";

/**
 * U-Boot legacy uImage header (U-Boot `include/image.h`, all fields
 * big-endian). Only the 64-byte header is interpreted here; payload bytes
 * are never decompressed, executed, or otherwise transformed.
 */
export const UIMAGE_MAGIC = 0x27051956;
export const UIMAGE_HEADER_SIZE = 64;
export const UIMAGE_NAME_LENGTH = 32;

/** Cap on multi-image sub-images: one inventory entry per sub-image. */
export const UIMAGE_MAX_SUB_IMAGES = 4096;

/** Bytes of payload prefix that can hold a maximal multi-image size table. */
export const UIMAGE_MULTI_TABLE_WINDOW = (UIMAGE_MAX_SUB_IMAGES + 1) * 4;

export interface UImageSubImage {
  readonly index: number;
  /** Byte offset of the sub-image payload relative to the carrier start. */
  readonly byteOffset: number;
  readonly declaredSize: number;
}

export interface UImageHeaderFields {
  readonly magic: number;
  readonly timestamp: number;
  readonly timestampIso: string;
  readonly payloadSize: number;
  readonly loadAddress: number;
  readonly entryPoint: number;
  readonly headerCrc32: number;
  readonly dataCrc32: number;
  readonly os: number;
  readonly osName: string;
  readonly arch: number;
  readonly archName: string;
  readonly type: number;
  readonly typeName: string;
  readonly compression: number;
  readonly compressionName: string;
  readonly name: string;
}

const ARCH_NAMES: Readonly<Record<number, string>> = {
  0: "invalid",
  1: "alpha",
  2: "arm",
  3: "x86",
  4: "ia64",
  5: "mips",
  6: "mips64",
  7: "ppc",
  8: "s390",
  9: "sh",
  10: "sparc",
  11: "sparc64",
  12: "m68k",
  13: "microblaze",
  14: "nios2",
  15: "blackfin",
  16: "avr32",
  17: "st200",
  18: "sandbox",
  19: "nds32",
  20: "openrisc",
  21: "arm64",
  22: "arc",
};

const OS_NAMES: Readonly<Record<number, string>> = {
  0: "invalid",
  1: "openbsd",
  2: "netbsd",
  3: "freebsd",
  4: "4_4bsd",
  5: "linux",
  6: "svr4",
  7: "esx",
  8: "solaris",
  9: "irix",
  10: "sco",
  11: "beos",
  12: "qnx",
  13: "vxworks",
  14: "lynxos",
  15: "windows",
};

const TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "invalid",
  1: "standalone",
  2: "kernel",
  3: "ramdisk",
  4: "multi",
  5: "firmware",
  6: "script",
  7: "filesystem",
  8: "flat_dt",
};

const COMPRESSION_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "gzip",
  2: "bzip2",
  3: "lzma",
  4: "lzo",
  5: "lz4",
  6: "zstd",
};

const named = (
  table: Readonly<Record<number, string>>,
  value: number,
): string => table[value] ?? "unknown";

/** True when the first four bytes are the U-Boot legacy magic. */
export const hasUImageMagic = (prefix: Buffer): boolean =>
  prefix.length >= 4 && prefix.readUInt32BE(0) === UIMAGE_MAGIC;

/**
 * Parse the 64-byte header and verify its CRC32 (computed over the header
 * with the ih_hcrc field zeroed, per `image_check_hcrc`). Fail-closed with
 * a named reason; the payload is not touched here.
 */
export const parseUImageHeaderFields = (
  header: Buffer,
): Result<UImageHeaderFields, string> => {
  if (header.length < UIMAGE_HEADER_SIZE)
    return err(
      `uImage header is truncated: ${header.length} bytes, expected ${UIMAGE_HEADER_SIZE}`,
    );
  if (header.readUInt32BE(0) !== UIMAGE_MAGIC)
    return err(
      `uImage magic mismatch: expected 0x${UIMAGE_MAGIC.toString(16)}, found 0x${header.readUInt32BE(0).toString(16)}`,
    );
  const declaredHeaderCrc = header.readUInt32BE(4);
  const zeroed = Buffer.from(header.subarray(0, UIMAGE_HEADER_SIZE));
  zeroed.writeUInt32BE(0, 4);
  if (crc32(zeroed) >>> 0 !== declaredHeaderCrc)
    return err(
      `uImage header CRC32 mismatch: declared 0x${declaredHeaderCrc.toString(16)}, computed 0x${(crc32(zeroed) >>> 0).toString(16)}`,
    );
  const timestamp = header.readUInt32BE(8);
  const nameBytes = header.subarray(32, 32 + UIMAGE_NAME_LENGTH);
  const nul = nameBytes.indexOf(0);
  const os = header[28] ?? 0;
  const arch = header[29] ?? 0;
  const type = header[30] ?? 0;
  const compression = header[31] ?? 0;
  return ok({
    magic: UIMAGE_MAGIC,
    timestamp,
    timestampIso: new Date(timestamp * 1000).toISOString(),
    payloadSize: header.readUInt32BE(12),
    loadAddress: header.readUInt32BE(16),
    entryPoint: header.readUInt32BE(20),
    headerCrc32: declaredHeaderCrc,
    dataCrc32: header.readUInt32BE(24),
    os,
    osName: named(OS_NAMES, os),
    arch,
    archName: named(ARCH_NAMES, arch),
    type,
    typeName: named(TYPE_NAMES, type),
    compression,
    compressionName: named(COMPRESSION_NAMES, compression),
    name: nameBytes
      .subarray(0, nul === -1 ? UIMAGE_NAME_LENGTH : nul)
      .toString("utf8"),
  });
};

/** Incremental IEEE CRC32, matching `node:zlib`'s one-shot `crc32`. */
export const createCrc32 = (): {
  update(chunk: Buffer): void;
  digest(): number;
} => {
  let crc = 0xff_ff_ff_ff;
  return {
    update(chunk: Buffer): void {
      for (const byte of chunk) {
        // Index is always 0..255 and the table has 256 entries; the
        // fallback only satisfies noUncheckedIndexedAccess.
        const tableValue = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
        crc = tableValue ^ (crc >>> 8);
      }
    },
    digest(): number {
      return (crc ^ 0xff_ff_ff_ff) >>> 0;
    },
  };
};

const CRC_TABLE: Uint32Array = (() => {
  const table: number[] = [];
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
    table.push(crc >>> 0);
  }
  return new Uint32Array(table);
})();

/**
 * Multi-file payload layout (U-Boot `image_multi_getimg`): the payload
 * begins with a table of big-endian sub-image sizes terminated by a zero
 * entry; the sub-image bytes follow the table in order. `prefix` must hold
 * the table's opening bytes (up to UIMAGE_MULTI_TABLE_WINDOW); the table
 * must terminate inside the payload and the sub-images must fit within
 * `payloadSize`. Trailing slack after the last sub-image is tolerated
 * because it stays inside the stored payload entry.
 */
export const parseMultiImageTable = (
  prefix: Buffer,
  payloadSize: number,
): Result<readonly UImageSubImage[], string> => {
  const sizes: number[] = [];
  let cursor = 0;
  for (;;) {
    if (cursor + 4 > prefix.length || cursor + 4 > payloadSize)
      return err(
        "uImage multi-image size table has no zero terminator inside the payload",
      );
    const size = prefix.readUInt32BE(cursor);
    cursor += 4;
    if (size === 0) break;
    sizes.push(size);
    if (sizes.length > UIMAGE_MAX_SUB_IMAGES)
      return err(
        `uImage multi-image table declares more than ${UIMAGE_MAX_SUB_IMAGES} sub-images`,
      );
  }
  const subImages: UImageSubImage[] = [];
  let offset = UIMAGE_HEADER_SIZE + cursor;
  for (const [index, size] of sizes.entries()) {
    if (offset + size > UIMAGE_HEADER_SIZE + payloadSize)
      return err(
        `uImage multi-image sub-image ${index} of ${size} bytes overruns the ${payloadSize}-byte payload`,
      );
    subImages.push({ index, byteOffset: offset, declaredSize: size });
    offset += size;
  }
  return ok(subImages);
};
