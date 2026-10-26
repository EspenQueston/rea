import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

interface AdvertisedPattern {
  readonly tool: string;
  readonly where: string;
  readonly pattern: string;
}

const collectPatterns = (
  value: unknown,
  where: string,
  tool: string,
  found: AdvertisedPattern[],
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectPatterns(entry, `${where}[${String(index)}]`, tool, found),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "pattern" && typeof entry === "string")
      found.push({ tool, where: `${where}/pattern`, pattern: entry });
    collectPatterns(entry, `${where}/${key}`, tool, found);
  }
};

it("advertises patterns that compile in v mode under the full profile", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer(
    { kind: "session", session },
    {
      logger: silentLogger,
      environment: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
    },
  );
  const client = new Client({ name: "full-profile-patterns", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const advertised = (await client.listTools()).tools;
  const patterns: AdvertisedPattern[] = [];
  for (const tool of advertised) {
    collectPatterns(tool.inputSchema, "inputSchema", tool.name, patterns);
    if (tool.outputSchema !== undefined)
      collectPatterns(tool.outputSchema, "outputSchema", tool.name, patterns);
  }

  // The compact catalog keeps these patterns off the wire, so the default
  // profile projection cannot observe them. `v` mode rejects an unescaped
  // `/`, `|` or trailing `-` inside a character class, and RE2 and Rust
  // validators reject look-around, so one such pattern refuses the complete
  // tools request for every client that compiles advertised patterns.
  // The win32 host-absolute localPath pattern advertised for
  // `browser.executable_path` is tracked separately by #7151 and filtered
  // out here; every other pattern this tool advertises must compile.
  const scenarioPatterns = patterns.filter(
    ({ tool, pattern }) =>
      tool === "capture_browser_scenario" && !pattern.includes("A-Za-z]:"),
  );
  expect(scenarioPatterns.length).toBeGreaterThan(0);

  const uncompilable = scenarioPatterns.flatMap((entry) =>
    ["", "u", "v"].flatMap((flags) => {
      try {
        new RegExp(entry.pattern, flags);
        return [];
      } catch (cause: unknown) {
        return [
          `${entry.tool} ${entry.where} /${entry.pattern}/${flags}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ];
      }
    }),
  );
  expect(uncompilable).toEqual([]);

  expect(
    scenarioPatterns.filter(({ pattern }) =>
      /\(\?<?[=!]|\\[1-9]|\\k</u.test(pattern),
    ),
  ).toEqual([]);
});
