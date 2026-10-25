import { describe, expect, it, vi, onTestFinished } from "vitest";
import { Cli } from "incur";
import pino from "pino";
import { registerPostgresCommands } from "./postgresCommands.js";
import { PostgresDatabaseService } from "../application/postgres/PostgresDatabaseService.js";
import {
  PostgresDatabaseProvider,
  type PostgresClientExecutor,
} from "../postgres/PostgresDatabaseProvider.js";
import * as postgresComposition from "../composition/postgres.js";

const silentLogger = pino({ level: "silent" });

const createMockExecutor = (): PostgresClientExecutor => ({
  async query(sql: string) {
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
        rows: [["audit_events", "public", "BASE TABLE", 3]],
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
          ["audit_events", "id", 1, "integer", "NO", null, true],
          ["audit_events", "event_type", 2, "text", "NO", null, false],
          ["audit_events", "details", 3, "text", "YES", null, false],
        ],
      };
    }
    if (
      sql.startsWith("SELECT") &&
      sql.includes('FROM "public"."audit_events"')
    ) {
      return {
        fields: [{ name: "id" }, { name: "event_type" }],
        rows: [
          [1, "user_login"],
          [2, "password_reset"],
        ],
      };
    }
    return { fields: [], rows: [] };
  },
  async close() {},
});

describe("PostgreSQL CLI Commands", () => {
  it("executes inspect-postgres-database --json and returns valid Evidence JSON", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockExecutor(),
    );
    const service = new PostgresDatabaseService(provider);
    vi.spyOn(
      postgresComposition,
      "createPostgresDatabaseService",
    ).mockReturnValue(service);

    const cli = Cli.create("rea-test", { sync: false });
    registerPostgresCommands(cli, silentLogger, {});

    let stdout = "";
    await cli.serve(
      [
        "inspect-postgres-database",
        "--database",
        "corp_db",
        "--table",
        "audit_events",
        "--column",
        "id",
        "--column",
        "event_type",
        "--row-limit",
        "5",
        "--json",
      ],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: () => {},
      },
    );

    const json = JSON.parse(stdout);
    expect(json).toMatchObject({
      operation: "inspect_postgres_database",
      confidence: "observed",
      parameters: {
        database: "corp_db",
        table: "audit_events",
        columns: ["id", "event_type"],
        row_limit: 5,
      },
      normalized_result: {
        engine: { name: "PostgreSQL" },
        rows: {
          table: "audit_events",
          columns: ["id", "event_type"],
          returned_rows: 2,
          truncated: false,
        },
      },
    });
  });

  it("redacts CLI passwords from JSON output and parameters", async () => {
    const provider = new PostgresDatabaseProvider(process.env, async () =>
      createMockExecutor(),
    );
    const service = new PostgresDatabaseService(provider);
    vi.spyOn(
      postgresComposition,
      "createPostgresDatabaseService",
    ).mockReturnValue(service);

    const cli = Cli.create("rea-test", { sync: false });
    registerPostgresCommands(cli, silentLogger, {});

    let stdout = "";
    const secret = "cli_super_secret_pw_999";
    await cli.serve(
      [
        "inspect-postgres-database",
        "--database",
        "corp_db",
        "--password",
        secret,
        "--json",
      ],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: () => {},
      },
    );

    expect(stdout).not.toContain(secret);
    const json = JSON.parse(stdout);
    expect(json.parameters.password).toBeUndefined();
  });
});
