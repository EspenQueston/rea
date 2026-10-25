import { describe, it, expect } from "vitest";
import { sliceNativeRegister } from "./nativeRegisterSlicing.js";
import {
  nativeRegisterProgramSchema,
  nativeRegisterSliceInputSchema,
} from "./nativeRegisterSlice.js";

const r = (index: number) => ({
  space: "register",
  offset: `0x${(index * 4).toString(16)}`,
  size: 4,
});
const c = (value: number) => ({
  space: "const",
  offset: `0x${value.toString(16)}`,
  size: 4,
});
type Op = ReturnType<
  typeof nativeRegisterProgramSchema.parse
>["operations"][number];
const op = (
  id: string,
  opcode: string,
  output: Op["output"],
  inputs: Op["inputs"],
  targets: string[],
  unknown: string | null = null,
): Op => ({
  id,
  instruction: id.split(":")[0]!,
  bytes: "00000000",
  opcode,
  output,
  inputs,
  successors: targets.map((target) => ({ target, predicate: null })),
  unknown,
});
const fixture = (operations: Op[], seed = "0x1004:0") =>
  nativeRegisterProgramSchema.parse({
    query: {
      procedure: "0x1000",
      instruction: seed.split(":")[0],
      value: { register: "r0" },
      when: "before",
      max_instructions: 80,
      max_operations: 1000,
      max_nodes: 300,
      max_edges: 600,
    },
    procedure: "0x1000",
    instruction: seed.split(":")[0],
    architecture: "ARM:LE:32:v7",
    register: r(0),
    seed,
    entry: "0x1000:0",
    seed_bytes: "00000000",
    operations,
    stop_reasons: [],
    limitations: [],
  });
const constants = (result: ReturnType<typeof sliceNativeRegister>) =>
  result.nodes
    .filter((n) => n.kind === "constant")
    .map((n) => n.storage.offset)
    .sort();
const definitions = (result: ReturnType<typeof sliceNativeRegister>) =>
  result.reaching_definitions.map(
    (id) => result.nodes.find((n) => n.id === id)?.operation?.id,
  );

describe("exact pre-instruction register origins", () => {
  it("selects the prior constant, never the write at or after the queried boundary", () => {
    const p = fixture([
      op("0x1000:0", "COPY", r(0), [c(7)], ["0x1004:0"]),
      op("0x1004:0", "COPY", r(0), [c(9)], ["0x1008:0"]),
    ]);
    expect(constants(sliceNativeRegister(p))).toEqual(["0x7"]);
    expect(sliceNativeRegister(p).explanation).toContain(
      "COPY of 0x7 at 0x1000",
    );
    expect(definitions(sliceNativeRegister(p))).toEqual(["0x1000:0"]);
    expect(constants(sliceNativeRegister({ ...p, seed: "0x1008:0" }))).toEqual([
      "0x9",
    ]);
  });
  it("follows copies and arithmetic and changes when the source register changes", () => {
    const ops = [
      op("0x1000:0", "COPY", r(1), [c(3)], ["0x1004:0"]),
      op("0x1004:0", "INT_ADD", r(0), [r(1), c(4)], ["0x1008:0"]),
    ];
    expect(constants(sliceNativeRegister(fixture(ops, "0x1008:0")))).toEqual([
      "0x3",
      "0x4",
    ]);
    ops[1]!.inputs[0] = r(2);
    const changed = sliceNativeRegister(fixture(ops, "0x1008:0"));
    expect(constants(changed)).toEqual(["0x4"]);
    expect(
      changed.nodes.some(
        (n) => n.kind === "entry" && n.storage.offset === "0x8",
      ),
    ).toBe(true);
  });
  it("retains both branch definitions and their distinct predicates", () => {
    const branch = op(
      "0x1000:0",
      "CBRANCH",
      null,
      [c(0), r(2)],
      ["0x1004:0", "0x1008:0"],
    );
    branch.successors[0]!.predicate = "flag != 0";
    branch.successors[1]!.predicate = "flag == 0";
    const p = fixture(
      [
        branch,
        op("0x1004:0", "COPY", r(0), [c(1)], ["0x100c:0"]),
        op("0x1008:0", "COPY", r(0), [c(2)], ["0x100c:0"]),
      ],
      "0x100c:0",
    );
    expect(constants(sliceNativeRegister(p))).toEqual(["0x1", "0x2"]);
    expect(definitions(sliceNativeRegister(p))).toEqual([
      "0x1004:0",
      "0x1008:0",
    ]);
    // The operation evidence retains the CFG, including predicates before definitions.
    expect(p.operations[0]!.successors.map((e) => e.predicate)).toEqual([
      "flag != 0",
      "flag == 0",
    ]);
    p.operations[0]!.successors = [p.operations[0]!.successors[0]!];
    // Disconnected blocks must not become reachable by removing a branch.
    expect(constants(sliceNativeRegister(p))).toEqual(["0x1"]);
  });
  it("keeps the incoming value on the false side of a predicated write", () => {
    const branch = op(
      "0x1004:0",
      "CBRANCH",
      null,
      [c(2), r(2)],
      ["0x1004:2", "0x1004:1"],
    );
    branch.successors[0]!.predicate = "condition false";
    const p = fixture(
      [
        op("0x1000:0", "COPY", r(0), [c(5)], ["0x1004:0"]),
        branch,
        op("0x1004:1", "COPY", r(0), [c(8)], ["0x1004:2"]),
        op("0x1004:2", "END", null, [], ["0x1008:0"]),
      ],
      "0x1008:0",
    );
    const result = sliceNativeRegister(p);
    expect(constants(result)).toEqual(["0x5", "0x8"]);
    expect(result.edges.some((e) => e.predicate === "condition false")).toBe(
      true,
    );
  });
  it("terminates with a retained loop-carried cycle", () => {
    const p = fixture(
      [
        op("0x1000:0", "COPY", r(0), [c(0)], ["0x1004:0"]),
        op("0x1004:0", "INT_ADD", r(0), [r(0), c(1)], ["0x1004:0", "0x1008:0"]),
      ],
      "0x1008:0",
    );
    const result = sliceNativeRegister(p);
    expect(result.coverage).toBe("complete-within-model");
    expect(constants(result)).toEqual(["0x0", "0x1"]);
    expect(result.nodes.length).toBeLessThan(20);
  });
  it("distinguishes a function entry dependency", () => {
    const result = sliceNativeRegister(
      fixture([op("0x1000:0", "END", null, [], ["0x1004:0"])]),
    );
    expect(result.nodes.filter((n) => n.kind === "entry")).toHaveLength(1);
  });
});

describe("unresolved dependencies and cutoffs", () => {
  it("traces a load address but leaves memory and a stack reload unresolved", () => {
    for (const address of [r(1), r(13)]) {
      const result = sliceNativeRegister(
        fixture([
          op("0x1000:0", "STORE", null, [c(0), address, r(0)], ["0x1000:1"]),
          op("0x1000:1", "LOAD", r(0), [c(0), address], ["0x1004:0"]),
        ]),
      );
      expect(result.unresolved).toBe(true);
      expect(
        result.nodes.some(
          (n) => n.kind === "entry" && n.storage.offset === address.offset,
        ),
      ).toBe(true);
      expect(
        result.nodes.some(
          (n) => n.operation?.opcode === "STORE" && n.kind === "definition",
        ),
      ).toBe(false);
    }
  });
  it("does not assume any register survives a call", () => {
    const result = sliceNativeRegister(
      fixture([
        op(
          "0x1000:0",
          "CALL",
          null,
          [c(0x2000)],
          ["0x1004:0"],
          "Unknown call effects",
        ),
      ]),
    );
    expect(result.nodes.some((n) => n.reason === "Unknown call effects")).toBe(
      true,
    );
    expect(result.nodes.some((n) => n.kind === "entry")).toBe(false);
  });
  it("retains unsupported semantics and missing predecessor uncertainty", () => {
    expect(
      sliceNativeRegister(
        fixture([
          op(
            "0x1000:0",
            "CALLOTHER",
            null,
            [],
            ["0x1004:0"],
            "Unsupported operation",
          ),
        ]),
      ).unresolved,
    ).toBe(true);
    expect(sliceNativeRegister(fixture([])).unresolved).toBe(true);
  });
  it("reports both graph budgets without inventing absence", () => {
    const p = fixture([op("0x1000:0", "COPY", r(0), [c(7)], ["0x1004:0"])]);
    for (const budget of [{ max_nodes: 1 }, { max_edges: 1 }]) {
      const result = sliceNativeRegister({
        ...p,
        query: { ...p.query, ...budget },
      });
      expect(result.coverage).toBe("partial-budget");
      expect(result.stop_reasons.length).toBeGreaterThan(0);
    }
  });
  it("reports only the exhausted node budget at function entry", () => {
    const p = fixture([op("0x1000:0", "END", null, [], [])], "0x1000:0");
    const result = sliceNativeRegister({
      ...p,
      query: { ...p.query, max_nodes: 1 },
    });
    expect(result.coverage).toBe("partial-budget");
    expect(result.stop_reasons).toEqual(["max_nodes"]);
    expect(result.edges).toHaveLength(0);
  });
  it("rejects unsupported register, boundary and invalid budgets", () => {
    const query = fixture([]).query;
    for (const change of [
      { value: { register: "pc" } },
      { when: "after" },
      { max_nodes: 0 },
      { max_operations: -1 },
    ])
      expect(
        nativeRegisterSliceInputSchema.safeParse({ ...query, ...change })
          .success,
      ).toBe(false);
  });
  it("marks missing control-flow coverage and producer cutoffs independently", () => {
    const p = fixture([op("0x1000:0", "COPY", r(0), [c(7)], ["0x1004:0"])]);
    const missing = sliceNativeRegister({
      ...p,
      limitations: ["Unresolved computed control-flow destination"],
    });
    expect(missing.coverage).toBe("partial-model");
    expect(
      missing.reaching_definitions.some(
        (id) => missing.nodes.find((n) => n.id === id)?.kind === "unknown",
      ),
    ).toBe(true);
    const partial = sliceNativeRegister({
      ...p,
      stop_reasons: ["max_instructions"],
    });
    expect(partial.coverage).toBe("partial-budget");
    expect(constants(partial)).toEqual(["0x7"]);
  });
  it("retains changed predicates in the control alternatives", () => {
    const branch = op("0x1000:0", "CBRANCH", null, [c(0), r(1)], ["0x1004:0"]);
    branch.successors[0]!.predicate = "Z == 0";
    const p = fixture([branch]);
    const first = sliceNativeRegister(p);
    p.operations[0]!.successors[0]!.predicate = "Z != 0";
    expect(sliceNativeRegister(p).control_flow).not.toEqual(first.control_flow);
  });
  it("does not pretend overlapping writes preserve a full register", () => {
    const result = sliceNativeRegister(
      fixture([
        op("0x1000:0", "COPY", { ...r(0), size: 1 }, [c(7)], ["0x1004:0"]),
      ]),
    );
    expect(result.unresolved).toBe(true);
  });
});
