import { z } from "incur";
import { createPostgresDatabaseService } from "../composition/postgres.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { inspectPostgresDatabaseInputSchema } from "../domain/postgres/postgresDatabase.js";

/** Register rea inspect-postgres-database command. */
export const registerPostgresCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createPostgresDatabaseService(environment);
  cli.command(CLI_COMMANDS.inspectPostgresDatabase, {
    description:
      "Inspect schema metadata and bounded ordinary-table rows from a PostgreSQL database",
    options: z.object({
      host: z.string().optional().describe("Host (default: localhost)"),
      port: z.number().int().optional().describe("Port (default: 5432)"),
      database: z.string().optional().describe("Database name"),
      connectionString: z
        .string()
        .optional()
        .describe("Connection URI (postgres://...)"),
      schema: z
        .string()
        .optional()
        .describe("Schema namespace (default: public)"),
      user: z.string().optional().describe("User (default: postgres)"),
      password: z
        .string()
        .optional()
        .describe("Password (redacted from output)"),
      table: z
        .string()
        .optional()
        .describe("Exact ordinary table name to sample"),
      column: z
        .array(z.string())
        .optional()
        .describe("Repeat to select exact row columns"),
      schemaScope: z
        .enum(["inventory", "selected_table", "database"])
        .optional()
        .describe("Schema scope"),
      rowLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Sample row limit (default: 20)"),
      workerTimeoutMs:
        inspectPostgresDatabaseInputSchema.shape.worker_timeout_ms,
    }),
    run: ({ options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectPostgresDatabase, () =>
          finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  ...(options.host !== undefined ? { host: options.host } : {}),
                  ...(options.port !== undefined ? { port: options.port } : {}),
                  ...(options.database !== undefined
                    ? { database: options.database }
                    : {}),
                  ...(options.connectionString !== undefined
                    ? { connection_string: options.connectionString }
                    : {}),
                  ...(options.schema !== undefined
                    ? { schema: options.schema }
                    : {}),
                  ...(options.user !== undefined ? { user: options.user } : {}),
                  ...(options.password !== undefined
                    ? { password: options.password }
                    : {}),
                  ...(options.table !== undefined
                    ? { table: options.table }
                    : {}),
                  ...(options.column !== undefined
                    ? { columns: options.column }
                    : {}),
                  ...(options.schemaScope !== undefined
                    ? { schema_scope: options.schemaScope }
                    : {}),
                  ...(options.rowLimit !== undefined
                    ? { row_limit: options.rowLimit }
                    : {}),
                  ...(options.workerTimeoutMs !== undefined
                    ? { worker_timeout_ms: options.workerTimeoutMs }
                    : {}),
                },
                { signal },
              ),
            service,
            "postgres",
            "inspect_postgres_database",
            signal,
          ),
        ),
      ),
  });
};
