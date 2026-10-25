import { describe, expect, it, vi } from "vitest";
import { PostgresDatabaseService } from "./PostgresDatabaseService.js";
import type { PostgresDatabasePort } from "./PostgresDatabasePort.js";
import { err, ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import {
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  POSTGRES_PROVIDER_IDENTITY,
  type PostgresDatabase,
} from "../../domain/postgres/postgresDatabase.js";

const createMockReport = (
  overrides?: Partial<PostgresDatabase>,
): PostgresDatabase => ({
  target: {
    host: "localhost",
    port: DEFAULT_POSTGRES_PORT,
    database: "app_db",
    schema: "public",
    user: "postgres",
  },
  engine: {
    name: "PostgreSQL",
    version: "16.1",
  },
  worker_timeout_ms: DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  database_encoding: "UTF-8",
  schema: {
    scope: "inventory",
    completeness: "complete",
    tables: [],
    indexes: [],
    views: [],
    triggers: [],
  },
  rows: null,
  limitations: [],
  ...overrides,
});

describe("PostgresDatabaseService validation and error handling", () => {
  it("returns cancelled error when signal is already aborted", async () => {
    const port: PostgresDatabasePort = {
      inspect: vi.fn(),
    };
    const service = new PostgresDatabaseService(port);
    const controller = new AbortController();
    controller.abort(new Error("caller aborted"));

    const result = await service.inspect(
      { database: "app_db" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(port.inspect).not.toHaveBeenCalled();
  });

  it("returns input error when raw input fails schema validation", async () => {
    const port: PostgresDatabasePort = {
      inspect: vi.fn(),
    };
    const service = new PostgresDatabaseService(port);

    // Missing database and connection_string
    const result = await service.inspect({ host: "localhost" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(port.inspect).not.toHaveBeenCalled();
  });

  it("propagates provider errors without modification", async () => {
    const portError = new AnalysisCancelledError("inspect_postgres_database");
    const port: PostgresDatabasePort = {
      inspect: vi.fn().mockResolvedValue(err(portError)),
    };
    const service = new PostgresDatabaseService(port);

    const result = await service.inspect({ database: "app_db" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(portError);
  });
});

describe("PostgresDatabaseService execution and Evidence creation", () => {
  it("creates evidence on valid inspection without rows", async () => {
    const report = createMockReport();
    const execution = createAnalysisExecution(
      report,
      POSTGRES_PROVIDER_IDENTITY,
    );
    const port: PostgresDatabasePort = {
      inspect: vi.fn().mockResolvedValue(ok(execution)),
    };
    const service = new PostgresDatabaseService(port);

    const result = await service.inspect({
      database: "app_db",
      password: "secret_should_not_leak",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.subject).toBeNull();
    expect(result.value.operation).toBe("inspect_postgres_database");
    expect(result.value.confidence).toBe("observed");
    // Ensure password was redacted from Evidence parameters!
    expect(result.value.parameters.password).toBeUndefined();
    expect(JSON.stringify(result.value.parameters)).not.toContain(
      "secret_should_not_leak",
    );
  });

  it("creates evidence on valid inspection with selected table and rows", async () => {
    const report = createMockReport({
      schema: {
        scope: "selected_table",
        completeness: "complete",
        tables: [
          {
            name: "users",
            schema: "public",
            kind: "table",
            column_count: 2,
            columns_completeness: "complete",
            columns: [
              {
                position: 1,
                name: "id",
                declared_type: "integer",
                not_null: true,
                default_sql: null,
                is_primary_key: true,
              },
              {
                position: 2,
                name: "name",
                declared_type: "text",
                not_null: true,
                default_sql: null,
                is_primary_key: false,
              },
            ],
          },
        ],
        indexes: [],
        views: [],
        triggers: [],
      },
      rows: {
        table: "users",
        columns: ["id", "name"],
        values: [
          [
            { type: "integer", value: "1" },
            { type: "text", value: "Admin" },
          ],
        ],
        row_limit: 10,
        returned_rows: 1,
        truncated: false,
        order: "unspecified",
      },
    });
    const execution = createAnalysisExecution(
      report,
      POSTGRES_PROVIDER_IDENTITY,
    );
    const port: PostgresDatabasePort = {
      inspect: vi.fn().mockResolvedValue(ok(execution)),
    };
    const service = new PostgresDatabaseService(port);

    const result = await service.inspect({
      database: "app_db",
      table: "users",
      columns: ["id", "name"],
      row_limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.normalized_result).toEqual(report);
  });

  it("returns AnalysisOutputError when provider result does not match selected database/table", async () => {
    const mismatchedReport = createMockReport({
      target: {
        host: "localhost",
        port: 5432,
        database: "different_db", // Mismatched!
        schema: "public",
        user: "postgres",
      },
    });
    const execution = createAnalysisExecution(
      mismatchedReport,
      POSTGRES_PROVIDER_IDENTITY,
    );
    const port: PostgresDatabasePort = {
      inspect: vi.fn().mockResolvedValue(ok(execution)),
    };
    const service = new PostgresDatabaseService(port);

    const result = await service.inspect({ database: "app_db" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
  });

  it("calls close on provider when service close is called", async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    const port: PostgresDatabasePort = {
      close: closeMock,
      inspect: vi.fn(),
    };
    const service = new PostgresDatabaseService(port);
    await service.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
