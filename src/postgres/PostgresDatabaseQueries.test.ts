import { describe, expect, it } from "vitest";
import {
  quoteIdentifier,
  buildSampleQuery,
  CATALOG_TABLES_QUERY,
  CATALOG_COLUMNS_QUERY,
  CATALOG_INDEXES_QUERY,
  CATALOG_VIEWS_QUERY,
  CATALOG_TRIGGERS_QUERY,
  SERVER_VERSION_QUERY,
} from "./PostgresDatabaseQueries.js";

describe("quoteIdentifier", () => {
  it("quotes standard SQL identifiers", () => {
    expect(quoteIdentifier("users")).toBe('"users"');
    expect(quoteIdentifier("first_name")).toBe('"first_name"');
  });

  it("escapes embedded double quotes correctly", () => {
    expect(quoteIdentifier('strange"column')).toBe('"strange""column"');
    expect(quoteIdentifier('"already_quoted"')).toBe('"""already_quoted"""');
  });

  it("throws on identifier containing null bytes", () => {
    expect(() => quoteIdentifier("bad\0identifier")).toThrow(/null byte/);
  });
});

describe("buildSampleQuery", () => {
  it("builds parameterized read for specific columns", () => {
    const query = buildSampleQuery("public", "users", ["id", "email"]);
    expect(query).toBe('SELECT "id", "email" FROM "public"."users" LIMIT $1');
  });

  it("builds parameterized read with custom schema", () => {
    const query = buildSampleQuery("auth", "accounts", ["account_id"]);
    expect(query).toBe('SELECT "account_id" FROM "auth"."accounts" LIMIT $1');
  });

  it("builds parameterized read when all columns are requested (*)", () => {
    const query = buildSampleQuery("public", "audit_log", undefined);
    expect(query).toBe('SELECT * FROM "public"."audit_log" LIMIT $1');
  });

  it("safely escapes schema, table, and column names with special characters", () => {
    const query = buildSampleQuery('my"schema', 'user"table', [
      'col"1',
      "user;DROP TABLE--",
    ]);
    expect(query).toBe(
      'SELECT "col""1", "user;DROP TABLE--" FROM "my""schema"."user""table" LIMIT $1',
    );
  });
});

describe("Fixed Catalog Queries", () => {
  it("defines immutable parameterized catalog queries", () => {
    expect(CATALOG_TABLES_QUERY).toContain("information_schema.tables");
    expect(CATALOG_COLUMNS_QUERY).toContain("information_schema.columns");
    expect(CATALOG_INDEXES_QUERY).toContain("pg_catalog.pg_indexes");
    expect(CATALOG_VIEWS_QUERY).toContain("information_schema.views");
    expect(CATALOG_TRIGGERS_QUERY).toContain("information_schema.triggers");
    expect(SERVER_VERSION_QUERY).toContain("version()");
  });
});
