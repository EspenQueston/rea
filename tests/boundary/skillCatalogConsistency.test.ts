import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { CLI_COMMAND_NAMES } from "../../src/cliCommandNames.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import {
  advertisedInputJsonSchema,
  toolOutputSchemaWithMetadata,
} from "../../src/contracts/toolSchemaMetadata.js";
import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../../src/application/SupportedClients.js";

/**
 * Guards the consistency between bundled agent skills and the advertised
 * catalog (morluto/rea#5244). A skill that documents a tool the server does
 * not advertise makes the documented workflow fail with `Unknown tool` for
 * every agent that follows it, even when `doctor` reports the catalog digest
 * as aligned: the digest only covers the catalog itself, not the set of names
 * the bundled skill prose references.
 *
 * The guard is deliberately name-based and CPU-only: it walks every bundled
 * `SKILL.md`, extracts backtick-quoted snake_case identifiers, and requires
 * each of them to be part of the advertised surface — an MCP tool name, a
 * documented tool input property, a CLI command, or a supported client name.
 */
const collectSkillFiles = (root: string): readonly string[] => {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "SKILL.md") files.push(path);
    }
  };
  walk(root);
  return files.sort();
};

const SNAKE_CASE_REFERENCE = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/gu;

const collectPropertyNames = (schema: JsonValue, into: Set<string>): void => {
  if (Array.isArray(schema)) {
    for (const item of schema) collectPropertyNames(item, into);
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const property of Object.keys(value)) into.add(property);
    }
    if (key === "enum" && Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") into.add(item);
    }
    collectPropertyNames(value, into);
  }
};

const advertisedToolNames = (): readonly string[] =>
  TOOL_CONTRACTS.map((contract) => contract.name);

const advertisedInputProperties = (): readonly string[] => {
  const names = new Set<string>();
  for (const contract of TOOL_CONTRACTS) {
    collectPropertyNames(
      advertisedInputJsonSchema(contract) as unknown as JsonValue,
      names,
    );
    collectPropertyNames(
      toolOutputSchemaWithMetadata(contract)["~standard"].jsonSchema.output({
        target: "draft-2020-12",
      }) as unknown as JsonValue,
      names,
    );
  }
  return [...names];
};

const advertisedErrorCodes = (): readonly string[] => {
  const options =
    (
      analysisErrorProjectionSchema as unknown as {
        _def?: { options?: readonly unknown[] };
      }
    )._def?.options ?? [];
  const codes: string[] = [];
  for (const option of options) {
    const code = (
      option as {
        shape?: { code?: { value?: string } };
      }
    ).shape?.code?.value;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
};

const advertisedClientNames = (): readonly string[] =>
  SUPPORTED_CLIENT_DEFINITIONS.map((client) => client.name);

const knownCatalogReferences = (): ReadonlySet<string> =>
  new Set<string>([
    ...advertisedToolNames(),
    ...advertisedInputProperties(),
    ...advertisedErrorCodes(),
    ...CLI_COMMAND_NAMES,
    ...advertisedClientNames(),
  ]);

const unknownSkillReferences = (
  skillRoot: string,
  known: ReadonlySet<string>,
): readonly string[] => {
  const unknown = new Map<string, string[]>();
  for (const file of collectSkillFiles(skillRoot)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SNAKE_CASE_REFERENCE)) {
      const reference = match[1] as string;
      if (known.has(reference)) continue;
      const files = unknown.get(reference) ?? [];
      files.push(file);
      unknown.set(reference, files);
    }
  }
  return [...unknown.entries()].map(
    ([reference, files]) => `${reference} <- ${files.join(", ")}`,
  );
};

const SKILL_ROOT = join(process.cwd(), ".agents", "skills");

it("advertises the catalog surface the guard compares against", () => {
  expect(advertisedToolNames().length).toBeGreaterThan(0);
  expect(advertisedInputProperties()).toContain("match_offset");
  expect(advertisedClientNames()).toContain("claude_code");
});

it("bundled skills only reference tools and commands that exist", () => {
  const skillFiles = collectSkillFiles(SKILL_ROOT);
  expect(skillFiles.length).toBeGreaterThan(0);
  expect(unknownSkillReferences(SKILL_ROOT, knownCatalogReferences())).toEqual(
    [],
  );
});
