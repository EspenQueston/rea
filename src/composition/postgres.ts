import { PostgresDatabaseService } from "../application/postgres/PostgresDatabaseService.js";
import {
  PostgresDatabaseProvider,
  type PostgresClientFactory,
} from "../postgres/PostgresDatabaseProvider.js";

/** Compose read-only PostgreSQL database inspection service. */
export const createPostgresDatabaseService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  clientFactory?: PostgresClientFactory,
): PostgresDatabaseService =>
  new PostgresDatabaseService(
    new PostgresDatabaseProvider(environment, clientFactory),
  );
