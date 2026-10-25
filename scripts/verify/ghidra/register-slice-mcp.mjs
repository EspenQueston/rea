import { createVerifierCommands } from "../../lib/verify-commands.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { requireMcpOperationResult } from "../../lib/mcp-verifier-results.mjs";
const directory = resolve(process.argv[2]);
const path = `${directory}/constant.bin`;
const bytes = Buffer.from("0700a0e31eff2fe1", "hex");
await writeFile(path, bytes, { flag: "wx" });
const digest = createHash("sha256").update(bytes).digest("hex");
const client = new Client({ name: "rea-register-slice-proof", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  env: {
    PATH: process.env.PATH,
    GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
    REA_ANALYSIS_PROVIDER: "ghidra",
    REA_LOG_LEVEL: "silent",
    GHIDRA_HEADLESS_MAXMEM: "1024M",
  },
  stderr: "pipe",
});
let diagnostics = "";
transport.stderr?.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-8192);
});
const call = async (name, args = {}) => {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  assert.notEqual(
    result.isError,
    true,
    `${JSON.stringify(result)}\n${diagnostics}`,
  );
  requireMcpOperationResult(result, name);
  return result.structuredContent;
};
const commands = await createVerifierCommands();
try {
  await client.connect(transport);
  await call("open_binary", {
    path,
    format: "raw-binary",
    architecture: "arm",
    entry_point: "0x1000",
  });
  const query = {
    procedure: "0x1000",
    instruction: "0x1004",
    value: { register: "r0" },
    when: "before",
    max_instructions: 80,
    max_operations: 1000,
    max_nodes: 300,
    max_edges: 600,
  };
  const compact = parseEvidence(await call("slice_native_register", query));
  assert.equal(compact.normalized_result.kind, "summary");
  const complete = parseEvidence(
    await call("slice_native_register", { ...query, detail: "complete" }),
  );
  assert.equal(complete.subject.digest.sha256, digest);
  assert.equal(
    compact.normalized_result.parent_evidence_id,
    complete.evidence_id,
  );
  assert.equal(complete.normalized_result.coverage, "complete-within-model");
  assert(
    complete.normalized_result.nodes.some(
      (n) => n.kind === "constant" && n.storage.offset === "0x7",
    ),
  );
  assert.equal(complete.normalized_result.seed_bytes, "1eff2fe1");
  assert(complete.analysis_profile.digest);
  const page = parseEvidence(
    await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: complete.evidence_id },
      view: { kind: "native-register-slice", collection: "nodes", limit: 2 },
    }),
  );
  assert.equal(page.normalized_result.items.length, 2);
  assert.equal(page.normalized_result.parent_evidence_id, complete.evidence_id);
  const invalid = await client.callTool(
    {
      name: "slice_native_register",
      arguments: { ...query, instruction: "0x1001" },
    },
    { timeout: 240000 },
  );
  assert.equal(invalid.isError, true);
  const bounded = parseEvidence(
    await call("slice_native_register", {
      ...query,
      detail: "complete",
      max_nodes: 1,
    }),
  );
  assert.equal(bounded.normalized_result.coverage, "partial-budget");
  assert(bounded.normalized_result.stop_reasons.includes("max_nodes"));
  assert.deepEqual(await readFile(path), bytes);
  await writeFile(
    `${directory}/retained-example.json`,
    JSON.stringify({ query, compact, complete, page }, null, 2),
    { flag: "wx" },
  );
  await call("close_binary");
  const { stdout } = await commands.exec(
    process.execPath,
    [
      resolve("scripts/rea.mjs"),
      "slice-native-register",
      path,
      "0x1000",
      "0x1004",
      "r0",
      "--when",
      "before",
      "--max_instructions",
      "80",
      "--max_operations",
      "1000",
      "--max_nodes",
      "300",
      "--max_edges",
      "600",
      "--target-format",
      "raw-binary",
      "--architecture",
      "arm",
      "--entry-point",
      "0x1000",
      "--provider",
      "ghidra",
      "--json",
    ],
    {
      env: { ...process.env, REA_ANALYSIS_PROVIDER: "ghidra" },
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const cli = parseEvidence(JSON.parse(stdout));
  assert.equal(cli.subject.digest.sha256, digest);
  assert.deepEqual(cli.normalized_result, complete.normalized_result);
  await writeFile(`${directory}/cli.json`, JSON.stringify(cli, null, 2), {
    flag: "wx",
  });

  console.log(
    "REA_REGISTER_SLICE_MCP_OK exact query, summary, retained graph, page, identity, bytes, invalid boundary, budgets and CLI parity",
  );
} finally {
  try {
    await client.close();
  } finally {
    try {
      await transport.close();
    } finally {
      await commands.close();
    }
  }
}
