import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { InspectPostgresDatabaseInput } from "../../domain/postgres/postgresDatabase.js";
import type { Result } from "../../domain/result.js";

/** Read-only PostgreSQL inspection boundary shared by CLI and MCP. */
export interface PostgresDatabasePort {
  close?(): Promise<void>;
  inspect(
    input: InspectPostgresDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
