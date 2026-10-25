import type {
  NativeLoadImage,
  NativeLoadImageObservation,
} from "../../src/domain/native/nativeLoadImage.js";

/** Authored domain observations; these projection fixtures run no provider. */
export const nativeLoadImageObservationFixture =
  (): NativeLoadImageObservation => ({
    executable_format: "Old-style DOS Executable (MZ)",
    language_id: "x86:LE:16:Real Mode",
    compiler_spec_id: "default",
    image_base: "0x0",
    default_address_space: "ram",
    source_files: [
      {
        name: "fixture.exe",
        size: 64,
        original_sha256: "a".repeat(64),
        modified_sha256: "a".repeat(64),
      },
    ],
    mappings: [
      {
        block: "module",
        start: "ram:0x0010",
        end: "ram:0x001f",
        address_space: "ram",
        initialized: true,
        loaded: true,
        overlay: false,
        length: 16,
        source_file_index: 0,
        file_offset: 32,
        sha256: "b".repeat(64),
      },
    ],
    relocations: [],
    entry_points: ["ram:0x0010"],
    entry_context: [],
  });

/** A recorded producer verification claim, not a runtime attestation by this fixture. */
export const nativeDosLoadImageFixture = (): Extract<
  NativeLoadImage,
  { format: "dos-mz" | "dos-com" }
> => ({
  status: "verified",
  format: "dos-mz",
  target_sha256: "a".repeat(64),
  load_segment: 0,
  header_bytes: 32,
  module_bytes: 32,
  overlay_bytes: 0,
  entry: { relative_segment: 0, offset: 16, linear_address: "ram:0x0010" },
  observations: nativeLoadImageObservationFixture(),
  checks: [
    {
      name: "original_file_sha256",
      matched: true,
      expected: "a".repeat(64),
      observed: "a".repeat(64),
      file_offset: null,
      address: null,
    },
  ],
  limitations: [],
});
