/*
 * Markdown output layout is adapted from Incur's Formatter.
 * Copyright (c) 2025-present weth, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
import { Formatter } from "incur";

export class CliDelimitedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliDelimitedOutputError";
  }
}

export interface CliDelimitedOutputOptions {
  readonly fields: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Keep REA's Markdown layout compatible with Incur while owning table safety. */
export const formatCliOutput = (
  value: unknown,
  format: Formatter.Format | "csv" | "tsv",
  delimited?: CliDelimitedOutputOptions,
): string => {
  if (format === "csv" || format === "tsv") {
    if (delimited === undefined)
      throw new CliDelimitedOutputError(
        "CSV/TSV output requires a selected row collection and explicit fields.",
      );
    return formatDelimitedRows(value, format, delimited);
  }
  return format === "md"
    ? formatMarkdown(value)
    : Formatter.format(value, format);
};

/** Render selected scalar cells, preceded by a versioned metadata record. */
export const formatDelimitedRows = (
  rows: unknown,
  format: "csv" | "tsv",
  options: CliDelimitedOutputOptions,
): string => [...formatDelimitedOutputParts(rows, format, options)].join("");

/** Validate the complete selected page before yielding its first output byte. */
export function* formatDelimitedOutputParts(
  rows: unknown,
  format: "csv" | "tsv",
  { fields, metadata }: CliDelimitedOutputOptions,
): Generator<string> {
  if (!isPlainObjectArray(rows))
    throw new CliDelimitedOutputError(
      Array.isArray(rows)
        ? "CSV/TSV output requires every selected row to be a plain object."
        : "The selected output path does not contain a row array.",
    );
  if (fields.length === 0)
    throw new CliDelimitedOutputError(
      "CSV/TSV output requires at least one explicitly selected field.",
    );

  const delimiter = format === "csv" ? "," : "\t";
  const lineEnding = format === "csv" ? "\r\n" : "\n";
  const encodedFields = fields.map((field) =>
    encodeDelimitedCell(field, format),
  );
  for (const record of rows)
    for (const field of fields)
      encodeDelimitedCell(
        Object.hasOwn(record, field) ? record[field] : undefined,
        format,
      );

  yield `# rea-delimited-v1 ${JSON.stringify(metadata)}${lineEnding}`;
  yield `${encodedFields.join(delimiter)}${lineEnding}`;
  for (const record of rows)
    yield `${fields
      .map((field) =>
        encodeDelimitedCell(
          Object.hasOwn(record, field) ? record[field] : undefined,
          format,
        ),
      )
      .join(delimiter)}${lineEnding}`;
}

const encodeDelimitedCell = (value: unknown, format: "csv" | "tsv"): string => {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "boolean") text = String(value);
  else if (typeof value === "number" && Number.isFinite(value))
    text = String(value);
  else
    throw new CliDelimitedOutputError(
      "CSV/TSV cells must be scalar values; nested objects and arrays are not flattened.",
    );
  const needsQuotes =
    format === "csv" ? /[",\r\n]/u.test(text) : /["\t\r\n]/u.test(text);
  return needsQuotes ? `"${text.replace(/"/gu, '""')}"` : text;
};

const isPlainObjectArray = (
  value: unknown,
): value is readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(value) &&
  value.every(
    (row: unknown) =>
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      (Object.getPrototypeOf(row) === Object.prototype ||
        Object.getPrototypeOf(row) === null),
  );

const isScalar = (value: unknown): boolean =>
  value === null || value === undefined || typeof value !== "object";

const isFlatObject = (value: Record<string, unknown>): boolean =>
  Object.values(value).every(isScalar);

const isObjectArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item),
  );

const escapeTableCell = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");

const renderTable = (
  headers: readonly string[],
  rows: readonly string[][],
): string => {
  const escapedHeaders = headers.map(escapeTableCell);
  const widths = escapedHeaders.map((header) => header.length);
  for (const row of rows) {
    for (let index = 0; index < escapedHeaders.length; index += 1) {
      const width = escapeTableCell(row[index] ?? "").length;
      if (width > widths[index]!) widths[index] = width;
    }
  }

  const pad = (value: string, index: number): string =>
    value.padEnd(widths[index]!);
  const lines = [
    `| ${escapedHeaders.map(pad).join(" | ")} |`,
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapedHeaders
        .map((_, index) => pad(escapeTableCell(row[index] ?? ""), index))
        .join(" | ")} |`,
    );
  }
  return lines.join("\n");
};

/** Keep nested JSON facts inside their owning table cell. */
const markdownCell = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : value === undefined
      ? ""
      : String(value);

const formatKeyValueTable = (value: Record<string, unknown>): string =>
  renderTable(
    ["Key", "Value"],
    Object.entries(value).map(([key, child]) => [key, markdownCell(child)]),
  );

const formatObjectTable = (
  items: readonly Record<string, unknown>[],
): string => {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of items)
    for (const key of Object.keys(item))
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
  return renderTable(
    headers,
    items.map((item) =>
      headers.map((key) =>
        markdownCell(Object.hasOwn(item, key) ? item[key] : undefined),
      ),
    ),
  );
};

const formatMarkdown = (
  value: unknown,
  path: readonly string[] = [],
): string => {
  if (value == null && path.length === 0) return "";
  if (isScalar(value)) {
    if (path.length === 0) return String(value);
    return `## ${path.join(".")}\n\n${String(value)}`;
  }
  if (Array.isArray(value)) {
    if (isObjectArray(value)) {
      const table = formatObjectTable(value);
      return path.length === 0 ? table : `## ${path.join(".")}\n\n${table}`;
    }
    return formatMarkdown(markdownCell(value), path);
  }

  const object = value as Record<string, unknown>;
  const entries = Object.entries(object);
  if (path.length === 0 && isFlatObject(object))
    return formatKeyValueTable(object);

  const needsHeadings =
    path.length > 0 ||
    entries.length > 1 ||
    entries.some(([, child]) => !isScalar(child));
  if (!needsHeadings) return formatKeyValueTable(object);

  return entries
    .map(([key, child]) => {
      const childPath = [...path, key];
      const heading = `## ${childPath.join(".")}\n\n`;
      if (isScalar(child)) return `${heading}${String(child)}`;
      if (isObjectArray(child)) return `${heading}${formatObjectTable(child)}`;
      if (
        typeof child === "object" &&
        child !== null &&
        !Array.isArray(child)
      ) {
        const nested = child as Record<string, unknown>;
        return isFlatObject(nested)
          ? `${heading}${formatKeyValueTable(nested)}`
          : formatMarkdown(nested, childPath);
      }
      return `${heading}${markdownCell(child)}`;
    })
    .join("\n\n");
};
