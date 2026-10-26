import { Readable, Transform, pipeline } from "node:stream";
import type { FileHandle } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

import type { UImageMetadata } from "../domain/artifactFormatMetadata.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  createCrc32,
  parseMultiImageTable,
  parseUImageHeaderFields,
  UIMAGE_HEADER_SIZE,
  UIMAGE_MAGIC,
  UIMAGE_MULTI_TABLE_WINDOW,
  type UImageHeaderFields,
} from "./uimage/UImageHeader.js";

const PAYLOAD_PATH = "payload.bin";
const READ_CHUNK_BYTES = 64 * 1024;

/** Read a U-Boot legacy uImage without running, decompressing, or altering it. */
export class UImageArtifactReader implements ArtifactReader {
  readonly format = "uimage" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  #prepared: Promise<void> | undefined;
  #header: UImageMetadata | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, "U-Boot uImage", admitted);
  }

  formatMetadata(): UImageMetadata | undefined {
    return this.#header === undefined ? undefined : { ...this.#header };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.read(signal);
    });
    options?.onCoverage?.({
      status: "complete",
      limitations:
        this.#header?.type_name === "multi"
          ? [
              "Multi-image sub-images are split from the stored size table; the payload entry retains the full stored bytes.",
            ]
          : [],
    });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          "uImage entry does not match its owning inventory",
        );
      const { handle } = await this.#source.read(signal);
      this.#assertOpen(signal);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw formatFailure("member has no physical byte range");
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  "uImage read cancelled",
                  {
                    cause: reason,
                  },
                ),
            });
      const output = this.#memberStream(stored, signal);
      output.on("error", () => undefined);
      this.#streams.add(output);
      void this.#scope
        .run(
          () =>
            new Promise<void>((resolve) => {
              pipeline(source, output, () => {
                this.#streams.delete(output);
                resolve();
              });
            }),
        )
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error("uImage stream ownership failed", { cause }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure("unavailable", "uImage reader closed"),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure("unavailable", "uImage reader closed");
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const headerBytes = await readRange(handle, 0, UIMAGE_HEADER_SIZE, signal);
    const fields = parseUImageHeaderFields(headerBytes);
    if (!fields.ok) throw formatFailure(fields.error);
    const header = fields.value;
    if (initial.size < UIMAGE_HEADER_SIZE + header.payloadSize)
      throw formatFailure(
        `uImage payload is truncated: header declares ${header.payloadSize} payload bytes but only ${initial.size - UIMAGE_HEADER_SIZE} follow the header`,
      );
    // Stream the payload once: verify the data CRC without buffering it,
    // and keep the opening bytes for a multi-image size table.
    const crc = createCrc32();
    const tableWindow = Math.min(header.payloadSize, UIMAGE_MULTI_TABLE_WINDOW);
    let tablePrefix = Buffer.alloc(0);
    let read = 0;
    while (read < header.payloadSize) {
      this.#assertOpen(signal);
      const chunk = await readRange(
        handle,
        UIMAGE_HEADER_SIZE + read,
        Math.min(READ_CHUNK_BYTES, header.payloadSize - read),
        signal,
      );
      if (chunk.length === 0)
        throw formatFailure("uImage payload ended before its declared size");
      crc.update(chunk);
      if (tablePrefix.length < tableWindow)
        tablePrefix = Buffer.concat([
          tablePrefix,
          chunk.subarray(0, tableWindow - tablePrefix.length),
        ]);
      read += chunk.length;
    }
    if (crc.digest() !== header.dataCrc32)
      throw formatFailure(
        `uImage data CRC32 mismatch: declared 0x${header.dataCrc32.toString(16)}, computed 0x${crc.digest().toString(16)}`,
      );
    let subImages: readonly {
      index: number;
      byteOffset: number;
      declaredSize: number;
    }[] = [];
    if (header.typeName === "multi") {
      const parsed = parseMultiImageTable(tablePrefix, header.payloadSize);
      if (!parsed.ok) throw formatFailure(parsed.error);
      subImages = parsed.value;
    }
    this.#header = toMetadata(header, subImages.length);
    this.#entries.set(
      "uimage:payload",
      entryFor(PAYLOAD_PATH, "uimage:payload", "payload", 0, {
        byteOffset: UIMAGE_HEADER_SIZE,
        declaredSize: header.payloadSize,
      }),
    );
    for (const sub of subImages)
      this.#entries.set(
        `uimage:image-${sub.index}`,
        entryFor(
          `image-${sub.index}.bin`,
          `uimage:image-${sub.index}`,
          "sub-image",
          sub.index,
          { byteOffset: sub.byteOffset, declaredSize: sub.declaredSize },
        ),
      );
  }

  #memberStream(entry: ArtifactEntry, signal?: AbortSignal): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== entry.declaredSize)
        throw formatFailure(`member ended early: ${entry.path}`);
      await this.#source.read(signal);
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error("uImage read failed", { cause }),
            ),
        );
      },
    });
  }
}

const formatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `uImage is malformed: ${detail}`);

const entryFor = (
  path: string,
  adapterKey: string,
  role: "payload" | "sub-image",
  index: number,
  range: { byteOffset: number; declaredSize: number },
): ArtifactEntry => ({
  path,
  kind: "file",
  declaredSize: range.declaredSize,
  compressedSize: null,
  executable: false,
  encrypted: false,
  byteOffset: range.byteOffset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [],
  adapterKey,
  formatMetadata: { kind: "uimage-entry", role, index },
  sourcePath: path,
});

const readRange = async (
  handle: FileHandle,
  position: number,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    assertArtifactReadActive(signal);
    const observed = await handle.read(
      bytes,
      read,
      length - read,
      position + read,
    );
    if (observed.bytesRead === 0) break;
    read += observed.bytesRead;
  }
  return bytes.subarray(0, read);
};

const toMetadata = (
  facts: UImageHeaderFields,
  subImageCount: number,
): UImageMetadata => ({
  kind: "uimage",
  magic: UIMAGE_MAGIC,
  timestamp: facts.timestamp,
  timestamp_iso: facts.timestampIso,
  payload_size: facts.payloadSize,
  load_address: facts.loadAddress,
  entry_point: facts.entryPoint,
  header_crc32: facts.headerCrc32,
  data_crc32: facts.dataCrc32,
  crc_verified: true,
  os: facts.os,
  os_name: facts.osName,
  arch: facts.arch,
  arch_name: facts.archName,
  type: facts.type,
  type_name: facts.typeName,
  compression: facts.compression,
  compression_name: facts.compressionName,
  name: facts.name,
  sub_image_count: subImageCount,
});
