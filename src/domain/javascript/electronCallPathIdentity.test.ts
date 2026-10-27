import { describe, expect, it } from "vitest";
import type { ElectronCallPath } from "./electronStaticAnalysisTypes.js";
import { electronCallPathId } from "./electronCallPathIdentity.js";

const path: ElectronCallPath = {
  entry_kind: "bridge-member",
  entry: "desktop.write",
  entry_path: ["desktop", "write"],
  channel: "literal",
  terminal: "renderer",
  resolution: "candidate",
  steps: [],
  conditions: [],
};

describe("electron call path identity", () => {
  it("is stable for the same path in the same module", () => {
    expect(electronCallPathId("src/preload.ts", path)).toBe(
      electronCallPathId("src/preload.ts", { ...path }),
    );
  });

  it("distinguishes identical paths owned by different modules", () => {
    expect(electronCallPathId("src/preload.ts", path)).not.toBe(
      electronCallPathId("src/fallback/preload.ts", path),
    );
  });
});
