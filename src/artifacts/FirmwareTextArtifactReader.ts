import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import type {
  IntelHexMetadata,
  SrecMetadata,
} from "../domain/artifactFormatMetadata.js";
import {
  FirmwareTextParseError,
  parseFirmwareText,
  type FirmwareTextFormat,
  type FirmwareTextLine,
} from "../domain/firmwareText.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

/** Intel HEX and S-record source lines are at most ~520 printable characters. */
const MAX_LINE_BYTES = 4096;
/** Bound retained entry metadata even for highly fragmented sparse images. */
const MAX_REGIONS = 100_000;

const addressRange = (start: number, end: number): string =>
  `0x${start.toString(16).padStart(8, "0")}-0x${end.toString(16).padStart(8, "0")}.bin`;

/** Decode Intel HEX or S-record text into address-contiguous extractable regions. */
export class FirmwareTextArtifactReader implements ArtifactReader {
  readonly format: FirmwareTextFormat;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #regions = new Map<string, Uint8Array>();
  readonly #source: ArtifactFileSource;
  #prepared: Promise<void> | undefined;
  #header: IntelHexMetadata | SrecMetadata | undefined;
  #closing = false;

  constructor(
    path: string,
    format: FirmwareTextFormat,
    admitted?: StableRegularFileDescriptor,
  ) {
    this.format = format;
    this.#source = new ArtifactFileSource(
      path,
      format === "intel-hex" ? "Intel HEX" : "S-record",
      admitted,
    );
  }

  formatMetadata(): IntelHexMetadata | SrecMetadata | undefined {
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
    const terminated =
      this.#header?.kind === "intel-hex"
        ? this.#header.eof_terminated
        : this.#header?.terminated;
    if (terminated === false)
      options?.onCoverage?.({
        status: "unknown",
        limitations: [
          this.#header?.kind === "intel-hex"
            ? "Intel HEX has no end-of-file record; decoded region coverage is unknown and gaps were not zero-filled."
            : "S-record has no termination record; decoded region coverage is unknown and gaps were not zero-filled.",
        ],
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
          "Firmware text region does not match its owning inventory",
        );
      const bytes = this.#regions.get(entry.adapterKey);
      if (bytes === undefined)
        throw new ArtifactReaderFailure(
          "integrity",
          "Firmware text region bytes are unavailable",
        );
      if (bytes.length !== entry.declaredSize)
        throw new ArtifactReaderFailure(
          "integrity",
          "Firmware text region length changed after inventory",
        );
      await this.#source.read(signal);
      return Readable.from([Buffer.from(bytes)]);
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
    this.#regions.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Firmware text reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    let parsed;
    try {
      parsed = await parseFirmwareText(
        this.format,
        this.#sourceLines(handle, signal),
        {
          maxExpandedBytes: artifactExpansionBudgetBytes(initial.size),
          maxRegions: MAX_REGIONS,
        },
      );
    } catch (cause: unknown) {
      if (cause instanceof FirmwareTextParseError)
        throw new ArtifactReaderFailure(cause.reason, cause.message, {
          ...(cause.reason === "limit" ? { boundary: "memory" as const } : {}),
          cause,
        });
      throw cause;
    }
    this.#header = parsed.metadata;
    let index = 0;
    for (const region of parsed.regions) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      const path = addressRange(region.startAddress, region.endAddress);
      const entry = {
        path,
        kind: "file" as const,
        declaredSize: region.bytes.length,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: `${this.format}-region:${String(index)}`,
        formatMetadata:
          this.format === "intel-hex"
            ? {
                kind: "intel-hex-region" as const,
                start_address: region.startAddress,
                end_address: region.endAddress,
              }
            : {
                kind: "srec-region" as const,
                start_address: region.startAddress,
                end_address: region.endAddress,
              },
      } satisfies ArtifactEntry;
      this.#entries.set(entry.adapterKey, entry);
      this.#regions.set(entry.adapterKey, region.bytes);
      index += 1;
    }
    await this.#source.read(signal);
  }

  async *#sourceLines(
    handle: Pick<FileHandle, "read">,
    signal?: AbortSignal,
  ): AsyncGenerator<FirmwareTextLine> {
    let carry = Buffer.alloc(0);
    let lineNumber = 0;
    for await (const chunk of readFileHandleChunks(handle, {
      signal,
      cancellationFailure: (reason) =>
        new ArtifactReaderFailure("cancelled", "Firmware text read cancelled", {
          cause: reason,
        }),
    })) {
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const bytes =
          carry.length === 0
            ? chunk.subarray(start, index)
            : Buffer.concat([carry, chunk.subarray(start, index)]);
        carry = Buffer.alloc(0);
        lineNumber += 1;
        yield { number: lineNumber, bytes };
        start = index + 1;
      }
      if (start >= chunk.length) continue;
      const remainder = chunk.subarray(start);
      carry =
        carry.length === 0
          ? Buffer.from(remainder)
          : Buffer.concat([carry, remainder]);
      if (carry.length > MAX_LINE_BYTES)
        throw new ArtifactReaderFailure(
          "format",
          `line ${String(lineNumber + 1)} exceeds the ${String(MAX_LINE_BYTES)}-byte firmware text record limit`,
        );
    }
    if (carry.length > 0) {
      lineNumber += 1;
      yield { number: lineNumber, bytes: carry };
    }
  }
}
