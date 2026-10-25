import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/createServer.js";
import { PostgresDatabaseService } from "../application/postgres/PostgresDatabaseService.js";
import {
  PostgresDatabaseProvider,
  type PostgresClientExecutor,
} from "./PostgresDatabaseProvider.js";
import { createTestBinarySession } from "../../tests/fixtures/binarySession.js";

const createServerWithPostgres = (service: PostgresDatabaseService) => {
  const session = createTestBinarySession(() => {
    throw new Error("No binary session needed for postgres inspection");
  });
  return createServer(
    { kind: "session", session },
    { postgresDatabase: service },
  );
};

const createMockPostgresClient = (options?: {
  rows?: unknown[][];
}): PostgresClientExecutor => ({
  async query(sql: string, params?: readonly unknown[]) {
    if (sql.includes("version()")) {
      return {
        fields: [{ name: "version" }],
        rows: [["PostgreSQL 16.2 on x86_64"]],
      };
    }
    if (sql.includes("information_schema.tables")) {
      return {
        fields: [
          { name: "table_name" },
          { name: "table_schema" },
          { name: "table_type" },
          { name: "column_count" },
        ],
        rows: [
          ["accounts", "public", "BASE TABLE", 3],
          ["transactions", "public", "BASE TABLE", 4],
        ],
      };
    }
    if (sql.includes("information_schema.columns")) {
      return {
        fields: [
          { name: "table_name" },
          { name: "column_name" },
          { name: "ordinal_position" },
          { name: "data_type" },
          { name: "is_nullable" },
          { name: "column_default" },
          { name: "is_primary_key" },
        ],
        rows: [
          ["accounts", "id", 1, "integer", "NO", null, true],
          ["accounts", "owner", 2, "text", "NO", null, false],
          ["accounts", "balance", 3, "numeric", "NO", null, false],
        ],
      };
    }
    if (sql.includes("pg_catalog.pg_indexes")) {
      return { fields: [], rows: [] };
    }
    if (sql.includes("information_schema.views")) {
      return { fields: [], rows: [] };
    }
    if (sql.includes("information_schema.triggers")) {
      return { fields: [], rows: [] };
    }
    if (sql.startsWith("SELECT") && sql.includes('FROM "public"."accounts"')) {
      return {
        fields: [{ name: "id" }, { name: "owner" }],
        rows: options?.rows ?? [
          [1001, "Alice"],
          [1002, "Bob"],
        ],
      };
    }
    return { fields: [], rows: [] };
  },
  async close() {},
});

describe("PostgreSQL MCP Tool Integration", () => {
  it("discovers inspect_postgres_database in tool list", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockPostgresClient(),
    );
    const service = new PostgresDatabaseService(provider);
    const server = createServerWithPostgres(service);
    const client = new Client({ name: "postgres-test-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsResult = await client.listTools();
    const tool = toolsResult.tools.find(
      (t) => t.name === "inspect_postgres_database",
    );
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("PostgreSQL");
    expect(tool?.inputSchema).toBeDefined();

    await client.close();
    await server.close();
  });

  it("inspects database schema inventory over MCP transport", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockPostgresClient(),
    );
    const service = new PostgresDatabaseService(provider);
    const server = createServerWithPostgres(service);
    const client = new Client({ name: "postgres-test-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "inspect_postgres_database",
      arguments: {
        database: "bank_db",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe("text");
    expect(response.structuredContent).toMatchObject({
      normalized_result: {
        engine: { name: "PostgreSQL" },
        schema: {
          scope: "inventory",
          tables: expect.arrayContaining([
            expect.objectContaining({ name: "accounts" }),
            expect.objectContaining({ name: "transactions" }),
          ]),
        },
        rows: null,
      },
    });

    await client.close();
    await server.close();
  });

  it("samples rows and renders readable markdown table over MCP transport", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockPostgresClient({
        rows: [
          [1, "Alice"],
          [2, "Bob"],
        ],
      }),
    );
    const service = new PostgresDatabaseService(provider);
    const server = createServerWithPostgres(service);
    const client = new Client({ name: "postgres-test-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const response = await client.callTool({
      name: "inspect_postgres_database",
      arguments: {
        database: "bank_db",
        table: "accounts",
        columns: ["id", "owner"],
        row_limit: 10,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      normalized_result: {
        schema: { scope: "selected_table" },
        rows: {
          table: "accounts",
          columns: ["id", "owner"],
          returned_rows: 2,
          truncated: false,
        },
      },
    });

    // Verify chat markdown table rendering!
    const textContent =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    expect(textContent).toContain("markdown_table");
    expect(textContent).toContain("| id | owner |");
    expect(textContent).toContain("| 1 | Alice |");
    expect(textContent).toContain("| 2 | Bob |");

    await client.close();
    await server.close();
  });

  it("redacts credentials in MCP arguments and structured Evidence", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockPostgresClient(),
    );
    const service = new PostgresDatabaseService(provider);
    const server = createServerWithPostgres(service);
    const client = new Client({ name: "postgres-test-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const secretPassword = "super_classified_pg_password_99";
    const response = await client.callTool({
      name: "inspect_postgres_database",
      arguments: {
        database: "secure_db",
        user: "dbadmin",
        password: secretPassword,
      },
    });

    expect(response.isError).not.toBe(true);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(secretPassword);

    await client.close();
    await server.close();
  });
});
