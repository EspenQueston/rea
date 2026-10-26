import { describe, expect, it } from "vitest";

import { isLegalFieldDescriptor, isLegalFieldName } from "./javaDescriptor.js";

// Each verdict matches OpenJDK 25 loading a class whose LocalVariableTable
// row carries the name or descriptor (ClassFormatError or not).
describe("isLegalFieldName", () => {
  it.each([
    ["x", 52, true],
    ["<x>", 52, true],
    ["a-b", 52, true],
    ["1x", 52, true],
    ["é", 52, true],
    ["", 52, false],
    ["a.b", 52, false],
    ["a;b", 52, false],
    ["a[b", 52, false],
    ["a/b", 52, false],
    ["x1", 48, true],
    ["$_", 48, true],
    ["é", 48, true],
    ["1x", 48, false],
    ["a-b", 48, false],
    ["a b", 48, false],
    ["<x>", 48, false],
    ["/x", 48, false],
  ] as const)("%j in version %i is %s", (name, major, legal) => {
    expect(isLegalFieldName(name, major)).toBe(legal);
  });
});

describe("isLegalFieldDescriptor", () => {
  const dims = (n: number): string => `${"[".repeat(n)}I`;
  it.each([
    ["I", 52, true],
    ["[I", 52, true],
    [dims(255), 52, true],
    [dims(256), 52, false],
    ["Ljava/lang/String;", 52, true],
    ["La-b;", 52, true],
    ["L1a;", 52, true],
    ["Q", 52, false],
    ["V", 52, false],
    ["", 52, false],
    ["II", 52, false],
    ["L;", 52, false],
    ["La//b;", 52, false],
    ["L/a;", 52, false],
    ["La/;", 52, false],
    ["La.b;", 52, false],
    ["La;x", 52, false],
    ["Ljava/lang/String", 52, false],
    // Before version 49 HotSpot uses identifier rules, which accept a leading
    // or trailing slash in a class name but not a digit first or a `-`.
    ["L/a;", 48, true],
    ["La/;", 48, true],
    ["L/;", 48, true],
    ["La/1b;", 48, true],
    ["L1a;", 48, false],
    ["La-b;", 48, false],
    ["La//b;", 48, false],
    [dims(256), 48, false],
  ] as const)("%j in version %i is %s", (descriptor, major, legal) => {
    expect(isLegalFieldDescriptor(descriptor, major)).toBe(legal);
  });
});
