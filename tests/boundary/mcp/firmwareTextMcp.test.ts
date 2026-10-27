import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  bytes,
  intelHexImage,
  intelHexRecord,
} from "../../fixtures/firmwareText.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it.each(["full", "compact"] as const)(
  "exposes Intel HEX facts and extraction through MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-hex-mcp-");
    const path = join(root, "firmware.hex");
    await writeFile(
      path,
      intelHexImage([
        intelHexRecord(4, 0, bytes(0x08, 0x00)),
        intelHexRecord(0, 0x0000, bytes(0xaa, 0xbb)),
        intelHexRecord(5, 0, bytes(0x08, 0x00, 0x00, 0x00)),
        intelHexRecord(1, 0),
      ]),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const inspected = await call("inspect_artifact", { detail: "summary" });
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const summary = z
        .object({
          parent_evidence_id: z.string(),
          summary: z.object({ root_format_metadata: z.unknown() }),
        })
        .parse(parseEvidence(inspected.structuredContent).normalized_result);
      expect(summary.summary.root_format_metadata).toMatchObject({
        kind: "intel-hex",
        variant: "i32",
        start_address: 0x0800_0000,
        eof_terminated: true,
      });
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(
        (
          await readFile(join(result.output_root, "0x08000000-0x08000001.bin"))
        ).equals(bytes(0xaa, 0xbb)),
      ).toBe(true);

      await call("close_binary", {});
      await writeFile(
        path,
        intelHexImage([
          intelHexRecord(0, 0, bytes(1, 2)),
          intelHexRecord(0, 1, bytes(9)),
          intelHexRecord(1, 0),
        ]),
      );
      await call("open_binary", { path });
      const invalid = await call("inspect_artifact", {});
      expect(JSON.stringify(parseMcpToolError(invalid))).toContain(
        "line 2: conflicting overlap",
      );
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);
