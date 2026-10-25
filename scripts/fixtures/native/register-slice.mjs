import { writeFile } from "node:fs/promises";
// Source-authored ARM little-endian words, loaded at 0x1000. No firmware inputs.
const fixtures = [
  [0xe3a00007, 0xe12fff1e], // mov r0,#7; bx lr
  [0xe3a01003, 0xe2810004, 0xe12fff1e], // mov r1,#3; add r0,r1,#4
  [0xe3520000, 0x0a000001, 0xe3a00001, 0xea000000, 0xe3a00002, 0xe12fff1e],
  [0xe3a00005, 0xe3520000, 0x03a00008, 0xe12fff1e], // conditional mov preserves 5
  [0xe3a00000, 0xe2800001, 0xe3500003, 0xbafffffc, 0xe12fff1e],
  [0xe12fff1e], // entry value
  [0xe3a00007, 0xe3a00009, 0xe12fff1e], // reuse, query before second mov
  [0xe2821004, 0xe5910000, 0xe12fff1e], // load via r2+4
  [0xe52d0004, 0xe49d0004, 0xe12fff1e], // stack store/reload, unresolved
  [0xeb00003e, 0xe12fff1e], // call, no assumed preservation
  [0xef000000, 0xe12fff1e], // svc, unsupported CALLOTHER
  [0xe12fff12, 0xe12fff1e], // unknown computed destination
];
const bytes = Buffer.alloc(fixtures.length * 0x100);
fixtures.forEach((words, i) =>
  words.forEach((word, j) => bytes.writeUInt32LE(word, i * 0x100 + j * 4)),
);
if (!process.argv[2]) throw new Error("Supply an output .bin path");
await writeFile(process.argv[2], bytes, { flag: "wx" });
