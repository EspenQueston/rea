import { describe, expect, it } from "vitest";
import {
  inspectPostgresDatabaseInputSchema,
  postgresDatabaseSchema,
  postgresInspectionParameters,
  postgresSchemaScope,
  renderPostgresTableMarkdown,
  redactPostgresConnectionString,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_ROW_LIMIT,
  DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  type PostgresRows,
} from "./postgresDatabase.js";

describe("inspectPostgresDatabaseInputSchema", () => {
  it("accepts minimal valid connection input with database", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      database: "target_db",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.database).toBe("target_db");
  });

  it("accepts full connection parameters and table selection", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      host: "db.internal",
      port: 5433,
      database: "app_db",
      user: "readonly_user",
      password: "secret_password",
      schema: "custom_schema",
      table: "users",
      columns: ["id", "username", "created_at"],
      row_limit: 10,
      schema_scope: "selected_table",
      worker_timeout_ms: 15_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts connection_string URI", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      connection_string:
        "postgres://readonly_user:secret@db.internal:5432/app_db",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects when neither database nor connection_string is provided", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      host: "localhost",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some(
        (i) =>
          i.path.includes("database") || i.path.includes("connection_string"),
      ),
    ).toBe(true);
  });

  it("rejects row_limit without table", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      row_limit: 5,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.includes("row_limit"))).toBe(
      true,
    );
  });

  it("rejects columns without table", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      columns: ["id"],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.includes("columns"))).toBe(
      true,
    );
  });

  it("rejects schema_scope selected_table without table", () => {
    const parsed = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      schema_scope: "selected_table",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.some((i) => i.path.includes("schema_scope")),
    ).toBe(true);
  });

  it("rejects non-positive row_limit", () => {
    const zero = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      table: "items",
      row_limit: 0,
    });
    expect(zero.success).toBe(false);

    const negative = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      table: "items",
      row_limit: -10,
    });
    expect(negative.success).toBe(false);
  });

  it("rejects invalid worker_timeout_ms", () => {
    const zeroTimeout = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      worker_timeout_ms: 0,
    });
    expect(zeroTimeout.success).toBe(false);

    const excessiveTimeout = inspectPostgresDatabaseInputSchema.safeParse({
      database: "test_db",
      worker_timeout_ms: 3_000_000_000,
    });
    expect(excessiveTimeout.success).toBe(false);
  });
});

describe("Credential Redaction", () => {
  it("redacts raw password and extracts masked connection parameters", () => {
    const input = {
      host: "localhost",
      port: 5432,
      database: "prod_db",
      user: "analyst",
      password: "super_secret_password_123!",
      table: "audit_logs",
      row_limit: 20,
    };
    const params = postgresInspectionParameters(input);
    expect(params.password).toBeUndefined();
    expect(params.host).toBe("localhost");
    expect(params.database).toBe("prod_db");
    expect(params.user).toBe("analyst");
    expect(params.table).toBe("audit_logs");
    expect(JSON.stringify(params)).not.toContain("super_secret_password_123!");
  });

  it("redacts password embedded in connection_string", () => {
    const uri =
      "postgresql://myuser:secretpassword456@db.internal:5432/company?sslmode=require";
    const redacted = redactPostgresConnectionString(uri);
    expect(redacted).toBe(
      "postgresql://myuser:[REDACTED]@db.internal:5432/company?sslmode=require",
    );
    expect(redacted).not.toContain("secretpassword456");

    const input = {
      connection_string: uri,
      database: "company",
    };
    const params = postgresInspectionParameters(input);
    expect(params.connection_string).toBe(
      "postgresql://myuser:[REDACTED]@db.internal:5432/company?sslmode=require",
    );
    expect(JSON.stringify(params)).not.toContain("secretpassword456");
  });

  it("handles connection_string without password cleanly", () => {
    const uri = "postgresql://myuser@db.internal:5432/company";
    const redacted = redactPostgresConnectionString(uri);
    expect(redacted).toBe(uri);
  });
});

describe("postgresSchemaScope", () => {
  it("defaults to inventory when table is omitted", () => {
    expect(postgresSchemaScope({ database: "test_db" })).toBe("inventory");
  });

  it("defaults to selected_table when table is provided", () => {
    expect(postgresSchemaScope({ database: "test_db", table: "orders" })).toBe(
      "selected_table",
    );
  });

  it("honors explicit database schema_scope", () => {
    expect(
      postgresSchemaScope({ database: "test_db", schema_scope: "database" }),
    ).toBe("database");
  });
});

describe("renderPostgresTableMarkdown", () => {
  it("renders a markdown table from rows", () => {
    const rows: PostgresRows = {
      table: "users",
      columns: ["id", "username", "role"],
      values: [
        [
          { type: "integer", value: "1" },
          { type: "text", value: "alice" },
          { type: "text", value: "admin" },
        ],
        [
          { type: "integer", value: "2" },
          { type: "text", value: "bob" },
          { type: "null" },
        ],
      ],
      row_limit: 20,
      returned_rows: 2,
      truncated: false,
      order: "unspecified",
    };
    const markdown = renderPostgresTableMarkdown(rows);
    expect(markdown).toContain("| id | username | role |");
    expect(markdown).toContain("| --- | --- | --- |");
    expect(markdown).toContain("| 1 | alice | admin |");
    expect(markdown).toContain("| 2 | bob | NULL |");
  });

  it("escapes pipe characters and newlines in text cells", () => {
    const rows: PostgresRows = {
      table: "notes",
      columns: ["content"],
      values: [[{ type: "text", value: "line 1\nline | 2" }]],
      row_limit: 10,
      returned_rows: 1,
      truncated: false,
      order: "unspecified",
    };
    const markdown = renderPostgresTableMarkdown(rows);
    expect(markdown).toContain("line 1\\nline \\| 2");
  });
});

describe("postgresDatabaseSchema", () => {
  it("validates a full inspection output report", () => {
    const report = {
      target: {
        host: "localhost",
        port: 5432,
        database: "mydb",
        schema: "public",
        user: "pg_read",
      },
      engine: {
        name: "PostgreSQL",
        version: "16.2",
      },
      worker_timeout_ms: DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
      database_encoding: "UTF-8",
      schema: {
        scope: "selected_table",
        completeness: "complete",
        tables: [
          {
            name: "customers",
            schema: "public",
            kind: "table",
            column_count: 2,
            columns_completeness: "complete",
            columns: [
              {
                position: 1,
                name: "id",
                declared_type: "bigint",
                not_null: true,
                default_sql: null,
                is_primary_key: true,
              },
              {
                position: 2,
                name: "email",
                declared_type: "text",
                not_null: false,
                default_sql: null,
                is_primary_key: false,
              },
            ],
          },
        ],
        indexes: [
          {
            name: "customers_pkey",
            table: "customers",
            schema: "public",
            is_unique: true,
            columns: ["id"],
          },
        ],
        views: [],
        triggers: [],
      },
      rows: {
        table: "customers",
        columns: ["id", "email"],
        values: [
          [
            { type: "integer", value: "101" },
            { type: "text", value: "test@example.com" },
          ],
        ],
        row_limit: 20,
        returned_rows: 1,
        truncated: false,
        order: "unspecified",
      },
      limitations: [],
    };
    const parsed = postgresDatabaseSchema.safeParse(report);
    expect(parsed.success).toBe(true);
  });

  it("fails validation if row counts or dimensions mismatch", () => {
    const report = {
      target: {
        host: "localhost",
        port: 5432,
        database: "mydb",
        schema: "public",
        user: "pg_read",
      },
      engine: {
        name: "PostgreSQL",
        version: "16.2",
      },
      schema: {
        scope: "inventory",
        completeness: "complete",
        tables: [],
        indexes: [],
        views: [],
        triggers: [],
      },
      rows: {
        table: "test",
        columns: ["col1", "col2"],
        values: [
          [{ type: "integer", value: "1" }], // Only 1 value, expected 2!
        ],
        row_limit: 20,
        returned_rows: 1,
        truncated: false,
        order: "unspecified",
      },
      limitations: [],
    };
    const parsed = postgresDatabaseSchema.safeParse(report);
    expect(parsed.success).toBe(false);
  });
});
