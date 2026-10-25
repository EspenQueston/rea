import { describe, expect, it, vi } from "vitest";
import { PostgresDatabaseProvider } from "./PostgresDatabaseProvider.js";
import type { PostgresClientExecutor } from "./PostgresDatabaseProvider.js";
import {
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  POSTGRES_PROVIDER_IDENTITY,
} from "../domain/postgres/postgresDatabase.js";
import {
  AnalysisResourceConstraintError,
  AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";

const createMockExecutor = (options?: {
  version?: string;
  tables?: unknown[][];
  columns?: unknown[][];
  rows?: unknown[][];
  onQuery?: (sql: string, params?: readonly unknown[]) => void;
}): PostgresClientExecutor => {
  const executedQueries: {
    sql: string;
    params?: readonly unknown[] | undefined;
  }[] = [];
  return {
    async query(sql: string, params?: readonly unknown[]) {
      executedQueries.push({ sql, params });
      options?.onQuery?.(sql, params);

      if (sql.includes("version()")) {
        return {
          fields: [{ name: "version" }],
          rows: [[options?.version ?? "PostgreSQL 16.2 on x86_64"]],
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
          rows: options?.tables ?? [
            ["users", "public", "BASE TABLE", 3],
            ["logs", "public", "BASE TABLE", 2],
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
          rows: options?.columns ?? [
            ["users", "id", 1, "integer", "NO", null, true],
            ["users", "username", 2, "text", "NO", null, false],
            ["users", "email", 3, "text", "YES", null, false],
          ],
        };
      }
      if (sql.includes("pg_catalog.pg_indexes")) {
        return {
          fields: [
            { name: "schemaname" },
            { name: "tablename" },
            { name: "indexname" },
            { name: "indexdef" },
          ],
          rows: [
            [
              "public",
              "users",
              "users_pkey",
              "CREATE UNIQUE INDEX users_pkey ON users USING btree (id)",
            ],
          ],
        };
      }
      if (sql.includes("information_schema.views")) {
        return {
          fields: [
            { name: "table_schema" },
            { name: "table_name" },
            { name: "view_definition" },
          ],
          rows: [],
        };
      }
      if (sql.includes("information_schema.triggers")) {
        return {
          fields: [
            { name: "trigger_schema" },
            { name: "table_name" },
            { name: "trigger_name" },
          ],
          rows: [],
        };
      }
      if (sql.startsWith("SELECT") && sql.includes('FROM "public"."users"')) {
        return {
          fields: [{ name: "id" }, { name: "username" }],
          rows: options?.rows ?? [
            [1, "alice"],
            [2, "bob"],
          ],
        };
      }
      return { fields: [], rows: [] };
    },
    async close() {},
  };
};

describe("PostgresDatabaseProvider transaction and inspection", () => {
  it("wraps queries in a read-only transaction with rollback", async () => {
    const executed: string[] = [];
    const client = createMockExecutor({
      onQuery: (sql) => executed.push(sql.trim()),
    });
    const provider = new PostgresDatabaseProvider(
      process.env,
      async () => client,
    );

    const result = await provider.inspect({
      database: "test_db",
    });
    expect(result.ok).toBe(true);
    expect(executed).toContain("BEGIN READ ONLY;");
    expect(executed).toContain("SET TRANSACTION READ ONLY;");
    expect(executed).toContain("ROLLBACK;");
  });

  it("inspects schema inventory by default", async () => {
    const client = createMockExecutor();
    const provider = new PostgresDatabaseProvider(
      process.env,
      async () => client,
    );

    const result = await provider.inspect({
      database: "test_db",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.value.result as any;
    expect(report.engine.name).toBe("PostgreSQL");
    expect(report.schema.scope).toBe("inventory");
    expect(report.schema.tables.length).toBe(2);
    expect(report.schema.tables[0].name).toBe("users");
    expect(report.rows).toBeNull();
  });
});

describe("PostgresDatabaseProvider sampling, redaction and limits", () => {
  it("samples rows from explicitly selected table and columns", async () => {
    const client = createMockExecutor({
      rows: [
        [1, "alice"],
        [2, "bob"],
      ],
    });
    const provider = new PostgresDatabaseProvider(
      process.env,
      async () => client,
    );

    const result = await provider.inspect({
      database: "test_db",
      table: "users",
      columns: ["id", "username"],
      row_limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.value.result as any;
    expect(report.schema.scope).toBe("selected_table");
    expect(report.rows).not.toBeNull();
    expect(report.rows.table).toBe("users");
    expect(report.rows.columns).toEqual(["id", "username"]);
    expect(report.rows.returned_rows).toBe(2);
    expect(report.rows.truncated).toBe(false);
    expect(report.rows.values).toEqual([
      [
        { type: "integer", value: "1" },
        { type: "text", value: "alice" },
      ],
      [
        { type: "integer", value: "2" },
        { type: "text", value: "bob" },
      ],
    ]);
  });

  it("detects and reports truncation when table has more rows than row_limit", async () => {
    // When row_limit is 2, provider queries with LIMIT 3 to detect if more rows exist
    const client = createMockExecutor({
      rows: [
        [1, "alice"],
        [2, "bob"],
        [3, "charlie"], // 3rd row returned
      ],
    });
    const provider = new PostgresDatabaseProvider(
      process.env,
      async () => client,
    );

    const result = await provider.inspect({
      database: "test_db",
      table: "users",
      columns: ["id", "username"],
      row_limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.value.result as any;
    expect(report.rows.returned_rows).toBe(2);
    expect(report.rows.truncated).toBe(true);
    expect(report.rows.values.length).toBe(2);
  });

  it("redacts credentials from error messages and logs", async () => {
    const failingClient: PostgresClientExecutor = {
      async query() {
        throw new Error(
          "password authentication failed for user 'admin' with secret password 'p@ssword999'",
        );
      },
      async close() {},
    };
    const provider = new PostgresDatabaseProvider(
      process.env,
      async () => failingClient,
    );

    const result = await provider.inspect({
      database: "test_db",
      user: "admin",
      password: "p@ssword999",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.userMessage).toContain("[REDACTED]");
    expect(result.error.userMessage).not.toContain("p@ssword999");
    expect(JSON.stringify(result.error)).not.toContain("p@ssword999");
    expect(JSON.stringify(result.error)).toContain("[REDACTED]");
  });

  it("enforces concurrency limit (rejects more than 2 concurrent calls)", async () => {
    let unblock1: () => void;
    let unblock2: () => void;
    const p1 = new Promise<void>((r) => (unblock1 = r));
    const p2 = new Promise<void>((r) => (unblock2 = r));

    const slowClient1: PostgresClientExecutor = {
      async query(sql) {
        if (sql.includes("version()")) await p1;
        return { fields: [], rows: [["PostgreSQL 16"]] };
      },
      async close() {},
    };
    const slowClient2: PostgresClientExecutor = {
      async query(sql) {
        if (sql.includes("version()")) await p2;
        return { fields: [], rows: [["PostgreSQL 16"]] };
      },
      async close() {},
    };

    let callCount = 0;
    const provider = new PostgresDatabaseProvider(process.env, async () => {
      callCount++;
      return callCount === 1 ? slowClient1 : slowClient2;
    });

    const call1 = provider.inspect({ database: "db1" });
    const call2 = provider.inspect({ database: "db2" });

    // 3rd call should immediately be rejected with AnalysisResourceConstraintError
    const call3 = await provider.inspect({ database: "db3" });
    expect(call3.ok).toBe(false);
    if (!call3.ok) {
      expect(call3.error).toBeInstanceOf(AnalysisResourceConstraintError);
    }

    unblock1!();
    unblock2!();
    await Promise.all([call1, call2]);
  });
});
