import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../jsonValue.js";

export const POSTGRES_PROVIDER_IDENTITY = {
  id: "postgres",
  name: "REA PostgreSQL database inspector",
  version: null,
} as const;

export const DEFAULT_POSTGRES_PORT = 5432;
export const DEFAULT_POSTGRES_ROW_LIMIT = 20;
export const DEFAULT_POSTGRES_WORKER_TIMEOUT_MS = 30_000;
export const MAX_POSTGRES_WORKER_TIMEOUT_MS = 2_147_483_647;

const workerTimeout = z
  .number()
  .int()
  .min(1)
  .max(MAX_POSTGRES_WORKER_TIMEOUT_MS);
const nonnegative = z.int().nonnegative();
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);

/** Redact password embedded in a postgres:// or postgresql:// connection URI. */
export const redactPostgresConnectionString = (uri: string): string => {
  return uri.replace(
    /^(postgres(?:ql)?:\/\/[^:]+:)(?:[^@]+)(@.+)$/i,
    "$1[REDACTED]$2",
  );
};

/** Input schema for inspect_postgres_database. */
export const inspectPostgresDatabaseInputSchema = z
  .strictObject({
    host: z
      .string()
      .min(1)
      .optional()
      .describe("PostgreSQL host or IP (default: localhost)"),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe("PostgreSQL port (default: 5432)"),
    database: z
      .string()
      .min(1)
      .optional()
      .describe("Database name to connect to"),
    connection_string: z
      .string()
      .min(1)
      .optional()
      .describe("Connection URI (e.g. postgres://user:pass@host:5432/db)"),
    schema: z
      .string()
      .min(1)
      .optional()
      .describe("PostgreSQL schema namespace (default: public)"),
    user: z
      .string()
      .min(1)
      .optional()
      .describe("Database user (default: postgres)"),
    password: z
      .string()
      .optional()
      .describe("Database password (will be redacted from Evidence and logs)"),
    ssl: z.boolean().optional().describe("Whether to use SSL connection"),
    table: z
      .string()
      .min(1)
      .optional()
      .describe("Exact ordinary table name to inspect/sample"),
    columns: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Exact row columns in requested order; requires table"),
    row_limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Sample size for selected table; default 20, requires table"),
    schema_scope: z
      .enum(["inventory", "selected_table", "database"])
      .optional()
      .describe(
        "Schema scope: inventory (default without table), selected_table (default with table), or database",
      ),
    worker_timeout_ms: workerTimeout
      .optional()
      .describe("Execution deadline in milliseconds (default 30000 ms)"),
  })
  .superRefine((input, context) => {
    if (!input.database && !input.connection_string) {
      context.addIssue({
        code: "custom",
        path: ["database"],
        message: "Either database or connection_string must be provided",
      });
    }
    if (input.row_limit !== undefined && input.table === undefined) {
      context.addIssue({
        code: "custom",
        path: ["row_limit"],
        message: "row_limit requires an explicit table selection",
      });
    }
    if (input.columns !== undefined && input.table === undefined) {
      context.addIssue({
        code: "custom",
        path: ["columns"],
        message: "columns requires an explicit table selection",
      });
    }
    if (input.schema_scope === "selected_table" && input.table === undefined) {
      context.addIssue({
        code: "custom",
        path: ["schema_scope"],
        message: "selected_table schema scope requires table",
      });
    }
  });

export type InspectPostgresDatabaseInput = z.infer<
  typeof inspectPostgresDatabaseInputSchema
>;

/** JSON-safe PostgreSQL cell value. */
export const postgresValueSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("null") }),
  z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({
    type: z.literal("integer"),
    value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/),
  }),
  z.strictObject({
    type: z.literal("real"),
    value: z.union([z.number(), z.enum(["Infinity", "-Infinity", "NaN"])]),
  }),
  z.strictObject({ type: z.literal("numeric"), value: z.string() }),
  z.strictObject({ type: z.literal("text"), value: z.string() }),
  z.strictObject({ type: z.literal("bytea"), hex }),
  z.strictObject({ type: z.literal("json"), value: jsonValueSchema }),
]);

export type PostgresValue = z.infer<typeof postgresValueSchema>;

export const postgresColumnSchema = z.strictObject({
  position: nonnegative,
  name: z.string().min(1),
  declared_type: z.string(),
  not_null: z.boolean(),
  default_sql: z.string().nullable(),
  is_primary_key: z.boolean(),
});

export const postgresTableSchema = z.strictObject({
  name: z.string().min(1),
  schema: z.string().min(1),
  kind: z.enum([
    "table",
    "view",
    "materialized_view",
    "foreign_table",
    "unknown",
  ]),
  column_count: nonnegative.nullable(),
  columns_completeness: z.enum(["complete", "unsupported", "not_requested"]),
  columns: z.array(postgresColumnSchema),
});

export const postgresIndexSchema = z.strictObject({
  name: z.string().min(1),
  table: z.string().min(1),
  schema: z.string().min(1),
  is_unique: z.boolean(),
  columns: z.array(z.string()),
});

export const postgresViewSchema = z.strictObject({
  name: z.string().min(1),
  schema: z.string().min(1),
  definition: z.string().nullable().optional(),
});

export const postgresTriggerSchema = z.strictObject({
  name: z.string().min(1),
  table: z.string().min(1),
  schema: z.string().min(1),
});

export const postgresRowsSchema = z.strictObject({
  table: z.string().min(1),
  columns: z.array(z.string()),
  values: z.array(z.array(postgresValueSchema)),
  row_limit: z.number().int().min(1),
  returned_rows: nonnegative,
  truncated: z.boolean(),
  order: z.literal("unspecified"),
});

export type PostgresColumn = z.infer<typeof postgresColumnSchema>;
export type PostgresTable = z.infer<typeof postgresTableSchema>;
export type PostgresIndex = z.infer<typeof postgresIndexSchema>;
export type PostgresView = z.infer<typeof postgresViewSchema>;
export type PostgresTrigger = z.infer<typeof postgresTriggerSchema>;
export type PostgresRows = z.infer<typeof postgresRowsSchema>;

export const postgresDatabaseSchema = z
  .strictObject({
    target: z.strictObject({
      host: z.string(),
      port: z.number(),
      database: z.string(),
      schema: z.string(),
      user: z.string(),
    }),
    engine: z.strictObject({
      name: z.literal("PostgreSQL"),
      version: z.string().min(1),
    }),
    worker_timeout_ms: workerTimeout.optional(),
    database_encoding: z.string().default("UTF-8"),
    schema: z.strictObject({
      scope: z.enum(["inventory", "selected_table", "database"]),
      completeness: z.literal("complete"),
      tables: z.array(postgresTableSchema),
      indexes: z.array(postgresIndexSchema),
      views: z.array(postgresViewSchema),
      triggers: z.array(postgresTriggerSchema),
    }),
    rows: postgresRowsSchema.nullable(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const rows = report.rows;
    if (
      rows !== null &&
      (rows.returned_rows !== rows.values.length ||
        rows.returned_rows > rows.row_limit ||
        rows.values.some((row) => row.length !== rows.columns.length))
    ) {
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message:
          "Selected row counts and column dimensions must match the retained values",
      });
    }
  });

export type PostgresDatabase = z.infer<typeof postgresDatabaseSchema>;

/** Redact credentials while preserving explicit caller selections in JSON. */
export const postgresInspectionParameters = (
  input: InspectPostgresDatabaseInput,
): Readonly<Record<string, JsonValue>> => {
  const result: Record<string, JsonValue> = {
    host: input.host ?? "localhost",
    port: input.port ?? DEFAULT_POSTGRES_PORT,
    ...(input.database !== undefined ? { database: input.database } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.user !== undefined ? { user: input.user } : {}),
    ...(input.table !== undefined ? { table: input.table } : {}),
    ...(input.columns !== undefined ? { columns: input.columns } : {}),
    ...(input.schema_scope !== undefined
      ? { schema_scope: input.schema_scope }
      : {}),
    ...(input.row_limit !== undefined ? { row_limit: input.row_limit } : {}),
    ...(input.worker_timeout_ms !== undefined
      ? { worker_timeout_ms: input.worker_timeout_ms }
      : {}),
  };
  if (input.connection_string !== undefined) {
    result.connection_string = redactPostgresConnectionString(
      input.connection_string,
    );
  }
  return result;
};

/** Resolve default or explicit schema scope. */
export const postgresSchemaScope = (
  input: InspectPostgresDatabaseInput,
): PostgresDatabase["schema"]["scope"] =>
  input.schema_scope ??
  (input.table === undefined ? "inventory" : "selected_table");

/** Escape markdown table cell characters. */
const escapeMarkdownTableCell = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "\\n");

/** Format a PostgresValue into display text for chat markdown. */
export const formatPostgresCellValue = (cell: PostgresValue): string => {
  switch (cell.type) {
    case "null":
      return "NULL";
    case "boolean":
      return cell.value ? "true" : "false";
    case "integer":
    case "numeric":
      return cell.value;
    case "real":
      return String(cell.value);
    case "text":
      return escapeMarkdownTableCell(cell.value);
    case "bytea":
      return `\\x${cell.hex}`;
    case "json":
      return escapeMarkdownTableCell(JSON.stringify(cell.value));
    default:
      return "";
  }
};

/** Render selected PostgreSQL row samples as a clean GitHub-style markdown table. */
export const renderPostgresTableMarkdown = (rows: PostgresRows): string => {
  if (rows.columns.length === 0) return "";
  const header = `| ${rows.columns.map((c) => escapeMarkdownTableCell(c)).join(" | ")} |`;
  const separator = `| ${rows.columns.map(() => "---").join(" | ")} |`;
  const body = rows.values.map(
    (row) =>
      `| ${row.map((cell) => formatPostgresCellValue(cell)).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n");
};
