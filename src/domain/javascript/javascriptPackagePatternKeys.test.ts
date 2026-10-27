import { describe, expect, it } from "vitest";

import {
  isSingleStarPatternKey,
  selectPackageSubpathPattern,
} from "./javascriptPackageSubpathPatterns.js";

describe("single-star pattern keys", () => {
  it.each([
    ["./*", true],
    ["./internal/*", true],
    ["./internal/*.js", true],
    [".", false],
    ["./exact", false],
    ["./*/", true],
    ["./a**", false],
    ["**", false],
  ])("classifies %j as a single-star pattern: %s", (key, expected) => {
    expect(isSingleStarPatternKey(key)).toBe(expected);
  });
});

describe("package pattern key matching", () => {
  it("captures the substring between prefix and suffix", () => {
    expect(
      selectPackageSubpathPattern(["./internal/*.mjs"], "./internal/db.mjs"),
    ).toEqual({ key: "./internal/*.mjs", capture: "db" });
  });

  it("requires the capture to consume at least one character", () => {
    expect(selectPackageSubpathPattern(["./feature*"], "./feature")).toBeNull();
  });

  it("prefers the pattern key with the longest prefix", () => {
    expect(
      selectPackageSubpathPattern(["./*", "./internal/*"], "./internal/db"),
    ).toEqual({ key: "./internal/*", capture: "db" });
  });

  it("breaks prefix ties with the longer suffix", () => {
    expect(selectPackageSubpathPattern(["./a*", "./a*c"], "./abc")).toEqual({
      key: "./a*c",
      capture: "b",
    });
  });

  it.each([
    ["a request no key encloses", "./other/db", ["./internal/*.js"]],
    ["a map without pattern keys", "./internal/db", ["./internal/exact"]],
  ])("refuses %s", (_name, request, keys) => {
    expect(selectPackageSubpathPattern(keys, request)).toBeNull();
  });

  it.each([
    ["./internal/x*", "x*"],
    ["./internal/x/", "x/"],
  ])("captures literal request text in %j", (request, capture) => {
    expect(selectPackageSubpathPattern(["./internal/*"], request)).toEqual({
      key: "./internal/*",
      capture,
    });
  });
});
