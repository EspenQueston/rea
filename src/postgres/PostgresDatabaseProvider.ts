import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { PostgresDatabasePort } from "../application/postgres/PostgresDatabasePort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_ROW_LIMIT,
  DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  POSTGRES_PROVIDER_IDENTITY,
  postgresSchemaScope,
  type InspectPostgresDatabaseInput,
  type PostgresColumn,
  type PostgresDatabase,
  type PostgresIndex,
  type PostgresRows,
  type PostgresTable,
  type PostgresValue,
} from "../domain/postgres/postgresDatabase.js";
import { POSTGRES_DATABASE_LIMITS } from "./PostgresDatabaseLimits.js";
import {
  buildSampleQuery,
  CATALOG_COLUMNS_QUERY,
  CATALOG_INDEXES_QUERY,
  CATALOG_TABLES_QUERY,
  CATALOG_TRIGGERS_QUERY,
  CATALOG_VIEWS_QUERY,
  SERVER_VERSION_QUERY,
} from "./PostgresDatabaseQueries.js";

const OPERATION = "inspect_postgres_database";

export interface PostgresQueryResult {
  readonly fields: readonly {
    readonly name: string;
    readonly dataTypeID?: number;
  }[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface PostgresClientExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult>;
  close(): Promise<void>;
}

export type PostgresClientFactory = (
  config: PostgresConnectionConfig,
) => Promise<PostgresClientExecutor>;

export interface PostgresConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly schema: string;
  readonly user: string;
  readonly password?: string | undefined;
  readonly ssl?: boolean | undefined;
}

/** Extract resolved connection parameters from input. */
export const resolvePostgresConfig = (
  input: InspectPostgresDatabaseInput,
): PostgresConnectionConfig => {
  let host = input.host ?? "localhost";
  let port = input.port ?? DEFAULT_POSTGRES_PORT;
  let database = input.database ?? "postgres";
  let user = input.user ?? "postgres";
  let password = input.password;
  let schema = input.schema ?? "public";

  if (input.connection_string) {
    try {
      const parsed = new URL(input.connection_string);
      if (parsed.hostname) host = parsed.hostname;
      if (parsed.port) port = parseInt(parsed.port, 10);
      if (parsed.pathname && parsed.pathname.length > 1) {
        database = parsed.pathname.slice(1);
      }
      if (parsed.username) user = parsed.username;
      if (parsed.password) password = parsed.password;
      const searchSchema =
        parsed.searchParams.get("schema") ||
        parsed.searchParams.get("currentSchema");
      if (searchSchema) schema = searchSchema;
    } catch {
      // Retain fallback defaults if URI fails WHATWG parsing
    }
  }

  return {
    host,
    port,
    database,
    schema,
    user,
    password,
    ssl: input.ssl,
  };
};

/** Redact passwords and connection secrets from arbitrary text or error messages. */
export const redactSecretText = (
  text: string,
  secrets: readonly (string | undefined)[],
): string => {
  let cleaned = text.replace(
    /^(postgres(?:ql)?:\/\/[^:]+:)(?:[^@]+)(@.+)$/gi,
    "$1[REDACTED]$2",
  );
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      cleaned = cleaned.replaceAll(secret, "[REDACTED]");
    }
  }
  return cleaned;
};

/** Map raw database cells into JSON-safe PostgresValue discriminated unions. */
export const mapPostgresCellToValue = (cell: unknown): PostgresValue => {
  if (cell === null || cell === undefined) {
    return { type: "null" };
  }
  if (typeof cell === "boolean") {
    return { type: "boolean", value: cell };
  }
  if (typeof cell === "number") {
    if (Number.isInteger(cell)) {
      return { type: "integer", value: String(cell) };
    }
    if (Number.isNaN(cell)) {
      return { type: "real", value: "NaN" };
    }
    if (cell === Infinity) {
      return { type: "real", value: "Infinity" };
    }
    if (cell === -Infinity) {
      return { type: "real", value: "-Infinity" };
    }
    return { type: "real", value: cell };
  }
  if (typeof cell === "bigint") {
    return { type: "integer", value: cell.toString() };
  }
  if (typeof cell === "string") {
    // Check if numeric decimal or integer
    return { type: "text", value: cell };
  }
  if (Buffer.isBuffer(cell) || cell instanceof Uint8Array) {
    return { type: "bytea", hex: Buffer.from(cell).toString("hex") };
  }
  if (typeof cell === "object") {
    return { type: "json", value: cell as any };
  }
  return { type: "text", value: String(cell) };
};

/**
 * Provider executing read-only PostgreSQL schema inspection and ordinary table reads.
 */
export class PostgresDatabaseProvider implements PostgresDatabasePort {
  readonly #active = new Set<
    Promise<Result<AnalysisExecution, AnalysisError>>
  >();

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly clientFactory?: PostgresClientFactory,
  ) {}

  async close(): Promise<void> {
    await Promise.allSettled(Array.from(this.#active));
  }

  async inspect(
    input: InspectPostgresDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (options?.signal?.aborted) {
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
        }),
      );
    }
    if (this.#active.size >= POSTGRES_DATABASE_LIMITS.concurrentInspections) {
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          "At most two PostgreSQL database inspections may execute simultaneously.",
          {
            retryable: true,
            active_inspections: this.#active.size,
            maximum_concurrency: POSTGRES_DATABASE_LIMITS.concurrentInspections,
          },
        ),
      );
    }

    const task = this.#executeInspection(input, options);
    this.#active.add(task);
    try {
      return await task;
    } finally {
      this.#active.delete(task);
    }
  }

  async #executeInspection(
    input: InspectPostgresDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const config = resolvePostgresConfig(input);
    const timeoutMs =
      input.worker_timeout_ms ?? DEFAULT_POSTGRES_WORKER_TIMEOUT_MS;
    const scope = postgresSchemaScope(input);
    const secrets = [config.password, input.password, input.connection_string];

    if (!this.clientFactory) {
      return err(
        new ProviderAdapterError(POSTGRES_PROVIDER_IDENTITY.id, OPERATION, {
          userMessage:
            "No PostgreSQL client connection factory configured for this environment.",
        }),
      );
    }

    let client: PostgresClientExecutor;
    try {
      client = await this.clientFactory(config);
    } catch (cause) {
      const rawMessage = cause instanceof Error ? cause.message : String(cause);
      const redacted = redactSecretText(rawMessage, secrets);
      return err(
        new ProviderAdapterError(POSTGRES_PROVIDER_IDENTITY.id, OPERATION, {
          userMessage: redacted,
          cause: new Error(redacted),
        }),
      );
    }

    try {
      if (options?.signal?.aborted) {
        return err(
          new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
          }),
        );
      }

      // Read-only transaction wrapping
      await client.query("BEGIN READ ONLY;");
      await client.query("SET TRANSACTION READ ONLY;");
      await client.query(
        `SET statement_timeout = ${Math.min(timeoutMs, 2_147_483_647)};`,
      );

      // 1. Server version
      const versionResult = await client.query(SERVER_VERSION_QUERY);
      const rawVersion =
        (versionResult.rows[0]?.[0] as string | undefined) ?? "PostgreSQL";
      const versionMatch = rawVersion.match(/PostgreSQL (\d+(?:\.\d+)*)/i);
      const parsedVersion = versionMatch ? versionMatch[1] : rawVersion;

      // 2. Schema tables
      const tablesResult = await client.query(CATALOG_TABLES_QUERY, [
        config.schema,
      ]);
      const tableNames: string[] = [];
      const tables: PostgresTable[] = [];

      for (const row of tablesResult.rows) {
        const name = String(row[0]);
        const schema = String(row[1]);
        const typeStr = String(row[2]);
        const columnCount =
          row[3] !== null && row[3] !== undefined ? Number(row[3]) : null;

        tableNames.push(name);

        let kind: PostgresTable["kind"] = "unknown";
        if (typeStr === "BASE TABLE") kind = "table";
        else if (typeStr === "VIEW") kind = "view";
        else if (typeStr === "FOREIGN") kind = "foreign_table";

        tables.push({
          name,
          schema,
          kind,
          column_count: columnCount,
          columns_completeness:
            scope === "inventory" ? "not_requested" : "complete",
          columns: [],
        });
      }

      // 3. Columns, indexes, views, triggers
      const shouldFetchColumns =
        scope === "database" ||
        (scope === "selected_table" && input.table !== undefined);
      const targetTable = scope === "selected_table" ? input.table : null;

      if (shouldFetchColumns) {
        const columnsResult = await client.query(CATALOG_COLUMNS_QUERY, [
          config.schema,
          targetTable,
        ]);
        for (const row of columnsResult.rows) {
          const tName = String(row[0]);
          const tableObj = tables.find((t) => t.name === tName);
          if (tableObj) {
            tableObj.columns.push({
              name: String(row[1]),
              position: Number(row[2]),
              declared_type: String(row[3]),
              not_null: String(row[4]).toUpperCase() === "NO",
              default_sql:
                row[5] !== null && row[5] !== undefined ? String(row[5]) : null,
              is_primary_key: Boolean(row[6]),
            });
            tableObj.columns_completeness = "complete";
          }
        }
      }

      const indexesResult = await client.query(CATALOG_INDEXES_QUERY, [
        config.schema,
        targetTable,
      ]);
      const indexes: PostgresIndex[] = indexesResult.rows.map((row) => ({
        schema: String(row[0]),
        table: String(row[1]),
        name: String(row[2]),
        is_unique: String(row[3]).includes("UNIQUE"),
        columns: [],
      }));

      const viewsResult = await client.query(CATALOG_VIEWS_QUERY, [
        config.schema,
        targetTable,
      ]);
      const views = viewsResult.rows.map((row) => ({
        schema: String(row[0]),
        name: String(row[1]),
        definition:
          row[2] !== null && row[2] !== undefined ? String(row[2]) : null,
      }));

      const triggersResult = await client.query(CATALOG_TRIGGERS_QUERY, [
        config.schema,
        targetTable,
      ]);
      const triggers = triggersResult.rows.map((row) => ({
        schema: String(row[0]),
        table: String(row[1]),
        name: String(row[2]),
      }));

      // 4. Sample rows if table is selected
      let rowsReport: PostgresRows | null = null;
      if (input.table !== undefined) {
        const rowLimit = input.row_limit ?? DEFAULT_POSTGRES_ROW_LIMIT;
        // Request limit + 1 to detect truncation
        const sampleQuery = buildSampleQuery(
          config.schema,
          input.table,
          input.columns,
        );
        const sampleResult = await client.query(sampleQuery, [rowLimit + 1]);

        const isTruncated = sampleResult.rows.length > rowLimit;
        const boundedRows = isTruncated
          ? sampleResult.rows.slice(0, rowLimit)
          : sampleResult.rows;

        const projectedColumns =
          input.columns ?? sampleResult.fields.map((f) => f.name);

        const mappedValues: PostgresValue[][] = boundedRows.map((r) =>
          r.map((cell) => mapPostgresCellToValue(cell)),
        );

        rowsReport = {
          table: input.table,
          columns: projectedColumns,
          values: mappedValues,
          row_limit: rowLimit,
          returned_rows: mappedValues.length,
          truncated: isTruncated,
          order: "unspecified",
        };
      }

      const report: PostgresDatabase = {
        target: {
          host: config.host,
          port: config.port,
          database: config.database,
          schema: config.schema,
          user: config.user,
        },
        engine: {
          name: "PostgreSQL",
          version: parsedVersion ?? "PostgreSQL",
        },
        worker_timeout_ms: timeoutMs,
        database_encoding: "UTF-8",
        schema: {
          scope,
          completeness: "complete",
          tables:
            scope === "selected_table" && input.table !== undefined
              ? tables.filter((t) => t.name === input.table)
              : tables,
          indexes,
          views,
          triggers,
        },
        rows: rowsReport,
        limitations: [],
      };

      return ok(createAnalysisExecution(report, POSTGRES_PROVIDER_IDENTITY));
    } catch (cause) {
      const rawMessage = cause instanceof Error ? cause.message : String(cause);
      const redacted = redactSecretText(rawMessage, secrets);
      return err(
        new ProviderAdapterError(POSTGRES_PROVIDER_IDENTITY.id, OPERATION, {
          userMessage: redacted,
          cause: new Error(redacted),
        }),
      );
    } finally {
      try {
        await client.query("ROLLBACK;");
      } catch {
        // Rollback failure is ignored on teardown
      }
      try {
        await client.close();
      } catch {
        // Close failure is ignored
      }
    }
  }
}
