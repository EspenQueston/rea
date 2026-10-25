import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PostgresDatabasePort } from "./PostgresDatabasePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceSubjectTarget,
} from "../../domain/evidence.js";
import {
  inspectPostgresDatabaseInputSchema,
  postgresDatabaseSchema,
  type InspectPostgresDatabaseInput,
  type PostgresDatabase,
  DEFAULT_POSTGRES_ROW_LIMIT,
  DEFAULT_POSTGRES_WORKER_TIMEOUT_MS,
  postgresSchemaScope,
  postgresInspectionParameters,
  renderPostgresTableMarkdown,
} from "../../domain/postgres/postgresDatabase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";

const OPERATION = "inspect_postgres_database";

const matchesSelectedDatabase = (
  report: PostgresDatabase,
  input: InspectPostgresDatabaseInput,
  _subject?: EvidenceSubjectTarget,
): boolean => {
  const expectedDb =
    input.database ??
    (input.connection_string
      ? new URL(input.connection_string).pathname.replace(/^\//, "")
      : undefined);
  if (expectedDb !== undefined && report.target.database !== expectedDb) {
    return false;
  }
  if (input.host !== undefined && report.target.host !== input.host) {
    return false;
  }
  if (input.port !== undefined && report.target.port !== input.port) {
    return false;
  }
  if (
    report.worker_timeout_ms !== undefined &&
    report.worker_timeout_ms !==
      (input.worker_timeout_ms ?? DEFAULT_POSTGRES_WORKER_TIMEOUT_MS)
  ) {
    return false;
  }
  if (report.schema.scope !== postgresSchemaScope(input)) {
    return false;
  }
  if (input.table === undefined) {
    if (report.rows !== null) return false;
  } else {
    if (
      report.rows === null ||
      report.rows.table !== input.table ||
      report.rows.row_limit !== (input.row_limit ?? DEFAULT_POSTGRES_ROW_LIMIT)
    ) {
      return false;
    }
    if (
      input.columns !== undefined &&
      (report.rows.columns.length !== input.columns.length ||
        !report.rows.columns.every((c, idx) => c === input.columns?.[idx]))
    ) {
      return false;
    }
  }
  return true;
};

/** Shared PostgreSQL inspection and caller-selection validation for CLI and MCP. */
export class PostgresDatabaseService {
  constructor(readonly provider: PostgresDatabasePort) {}

  /** Await provider shutdown and cleanup. */
  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect a PostgreSQL endpoint, returning schema inventory and selected table rows. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted) {
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options.signal.reason,
        }),
      );
    }
    const input = inspectPostgresDatabaseInputSchema.safeParse(rawInput);
    if (!input.success) {
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    }
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;

    const execution = inspected.value;
    const report = postgresDatabaseSchema.safeParse(execution.result);
    if (
      !report.success ||
      !matchesSelectedDatabase(
        report.data,
        input.data,
        execution.subject ?? undefined,
      )
    ) {
      return err(
        new AnalysisOutputError(
          OPERATION,
          "PostgreSQL adapter returned malformed data or changed the selected target database/table/row limit/worker budget.",
        ),
      );
    }

    const tableMarkdown = report.data.rows
      ? renderPostgresTableMarkdown(report.data.rows)
      : undefined;

    return ok(
      createEvidence(execution.subject ?? undefined, execution.provider, {
        operation: OPERATION,
        parameters: postgresInspectionParameters(input.data),
        result: jsonValueSchema.parse(report.data),
        rawResult: tableMarkdown
          ? { markdown_table: tableMarkdown }
          : (execution.rawResult ?? null),
        confidence: "observed",
        locations: execution.locations,
        limitations: execution.limitations,
      }),
    );
  }
}
