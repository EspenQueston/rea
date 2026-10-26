import { expect, it } from "vitest";

import {
  CliDelimitedOutputError,
  formatDelimitedRows,
} from "../../../src/cli/cliOutputFormatter.js";

const parseDelimited = (source: string, delimiter: string): string[][] => {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      record.push(cell);
      cell = "";
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  if (cell.length > 0 || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
};

it.each([
  { format: "csv" as const, delimiter: "," },
  { format: "tsv" as const, delimiter: "\t" },
])(
  "round-trips escaped $format fields and Unicode values",
  ({ format, delimiter }) => {
    const rows = [
      {
        name: 'A, "quoted" name',
        note: "first line\r\nsecond\tline — café 雪",
        count: 0,
        ignored: { nested: true },
      },
      { name: "", note: "", count: false },
      { name: "欠", count: null },
    ];
    const output = formatDelimitedRows(rows, format, {
      fields: ["name", "note", "count"],
      metadata: {
        version: 1,
        coverage: { status: "page", examined: 3, total: 8, next_offset: 3 },
        view: { offset: 0, limit: 3 },
      },
    });
    const lineEnding = format === "csv" ? "\r\n" : "\n";
    const metadataEnd = output.indexOf(lineEnding);
    const metadataLine = output.slice(0, metadataEnd);
    const records = output
      .slice(metadataEnd + lineEnding.length)
      .replace(/\r?\n$/u, "");
    expect(
      JSON.parse(metadataLine!.slice("# rea-delimited-v1 ".length)),
    ).toEqual({
      version: 1,
      coverage: { status: "page", examined: 3, total: 8, next_offset: 3 },
      view: { offset: 0, limit: 3 },
    });
    expect(parseDelimited(records, delimiter)).toEqual([
      ["name", "note", "count"],
      ['A, "quoted" name', "first line\r\nsecond\tline — café 雪", "0"],
      ["", "", "false"],
      ["欠", "", ""],
    ]);
  },
);

it("does not flatten nested selected field values", () => {
  expect(() =>
    formatDelimitedRows([{ details: { name: "nested" } }], "csv", {
      fields: ["details"],
      metadata: {},
    }),
  ).toThrow(CliDelimitedOutputError);
});
