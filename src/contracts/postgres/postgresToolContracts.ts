import {
  inspectPostgresDatabaseInputSchema,
  postgresDatabaseSchema,
} from "../../domain/postgres/postgresDatabase.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Read-only PostgreSQL inspection contract. */
export const POSTGRES_TOOL_CONTRACTS = [
  {
    name: "inspect_postgres_database",
    ...toolContractMetadata("inspect_postgres_database"),
    kind: "artifact-provider",
    requiresActiveTarget: false,
    description:
      "Inspect schema metadata and bounded ordinary-table rows from a caller-selected PostgreSQL database under a strict read-only transaction. Fixed catalog queries discover tables, columns, indexes, views, and triggers. Selecting an ordinary table samples rows (default 20) with parameterized queries for explicitly selected columns only; no arbitrary SQL, DDL, or DML. Credentials are redacted from Evidence, CLI JSON, and error logs. Concurrency is limited to 2 simultaneous inspections with strict row and timeout bounds.",
    inputSchema: inspectPostgresDatabaseInputSchema,
    outputSchema: evidenceResultOf(postgresDatabaseSchema),
    examples: [
      {
        title: "Inspect compact schema inventory of a database",
        input: { database: "application" },
      },
      {
        title: "Read selected rows from an ordinary table",
        input: {
          database: "application",
          table: "settings",
          columns: ["key", "value"],
          row_limit: 20,
        },
      },
      {
        title: "Expand full schema declarations",
        input: {
          database: "application",
          schema_scope: "database",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
