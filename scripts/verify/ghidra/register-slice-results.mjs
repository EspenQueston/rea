import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  nativeRegisterProgramSchema,
  nativeRegisterSliceSchema,
} from "../../../dist/domain/native/nativeRegisterSlice.js";
import { sliceNativeRegister } from "../../../dist/domain/native/nativeRegisterSlicing.js";
const captures = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(captures.length, 12);
const results = captures.map((value) =>
  nativeRegisterSliceSchema.parse(
    sliceNativeRegister(nativeRegisterProgramSchema.parse(value)),
  ),
);
const constants = (i) =>
  results[i].nodes
    .filter((n) => n.kind === "constant")
    .map((n) => BigInt(n.storage.offset).toString())
    .sort();
assert.deepEqual(constants(0), ["7"]);
assert.deepEqual(constants(1), ["3", "4"]);
assert.deepEqual(constants(2), ["1", "2"]);
assert.deepEqual(constants(3), ["5", "8"]);
assert.deepEqual(constants(4), ["0", "1"]);
assert(results[5].nodes.some((n) => n.kind === "entry"));
assert.deepEqual(constants(6), ["7"]);
for (const i of [7, 8]) {
  assert(results[i].unresolved);
  assert(results[i].nodes.some((n) => n.operation?.opcode === "LOAD"));
}
assert(results[7].nodes.some((n) => n.kind === "entry"));
assert(constants(7).includes("4"));
assert(results[9].nodes.some((n) => n.reason?.includes("call effects")));
assert(results[10].nodes.some((n) => n.reason?.includes("Unsupported")));
assert.equal(results[11].coverage, "partial-model");
assert(results[3].control_flow.some((e) => e.predicate !== null));
for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(results[i].coverage, "complete-within-model", `fixture ${i}`);
assert.equal(captures[0].seed_bytes, "1eff2fe1");
assert(results[0].nodes.some((n) => n.operation?.bytes === "0700a0e3"));
await writeFile(
  process.argv[3],
  JSON.stringify({ captures, results }, null, 2),
  { flag: "wx" },
);
console.log(
  "REA_REGISTER_SLICE_RESULTS_OK 12 real ARM fixtures; original bytes, joins, predication, cycles and unknowns checked",
);
