/**
 * Fixed catalog queries and safe parameterized query builder for read-only
 * PostgreSQL database inspection.
 *
 * Reject arbitrary SQL, DDL, and DML. Use only fixed catalog queries
 * and strictly quoted identifiers for selected tables and columns.
 */

/** Safely quote and escape a PostgreSQL SQL identifier (double quotes). */
export const quoteIdentifier = (identifier: string): string => {
  if (identifier.includes("\0")) {
    throw new Error("SQL identifier cannot contain null bytes");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
};

/** Build a parameterized SELECT query bounded by LIMIT $1. */
export const buildSampleQuery = (
  schema: string,
  table: string,
  columns?: readonly string[],
): string => {
  const quotedSchema = quoteIdentifier(schema);
  const quotedTable = quoteIdentifier(table);
  const projected =
    columns === undefined || columns.length === 0
      ? "*"
      : columns.map((col) => quoteIdentifier(col)).join(", ");
  return `SELECT ${projected} FROM ${quotedSchema}.${quotedTable} LIMIT $1`;
};

/** Fixed query for server version. */
export const SERVER_VERSION_QUERY = "SELECT version();";

/** Fixed query to fetch tables in a schema namespace. */
export const CATALOG_TABLES_QUERY = `
SELECT 
  t.table_name,
  t.table_schema,
  t.table_type,
  (
    SELECT count(*)::int
    FROM information_schema.columns c
    WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
  ) AS column_count
FROM information_schema.tables t
WHERE t.table_schema = $1
ORDER BY t.table_name ASC;
`.trim();

/** Fixed query to fetch columns for a table or schema. */
export const CATALOG_COLUMNS_QUERY = `
SELECT 
  c.table_name,
  c.column_name,
  c.ordinal_position,
  c.data_type,
  c.is_nullable,
  c.column_default,
  CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_primary_key
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.table_schema, kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON c.table_schema = pk.table_schema 
     AND c.table_name = pk.table_name 
     AND c.column_name = pk.column_name
WHERE c.table_schema = $1 AND ($2::text IS NULL OR c.table_name = $2)
ORDER BY c.table_name ASC, c.ordinal_position ASC;
`.trim();

/** Fixed query to fetch index definitions. */
export const CATALOG_INDEXES_QUERY = `
SELECT 
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = $1 AND ($2::text IS NULL OR tablename = $2)
ORDER BY tablename ASC, indexname ASC;
`.trim();

/** Fixed query to fetch views. */
export const CATALOG_VIEWS_QUERY = `
SELECT 
  table_schema,
  table_name,
  view_definition
FROM information_schema.views
WHERE table_schema = $1 AND ($2::text IS NULL OR table_name = $2)
ORDER BY table_name ASC;
`.trim();

/** Fixed query to fetch triggers. */
export const CATALOG_TRIGGERS_QUERY = `
SELECT 
  trigger_schema,
  event_object_table AS table_name,
  trigger_name
FROM information_schema.triggers
WHERE trigger_schema = $1 AND ($2::text IS NULL OR event_object_table = $2)
ORDER BY event_object_table ASC, trigger_name ASC;
`.trim();
