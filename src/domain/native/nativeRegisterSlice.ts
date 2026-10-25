import { z } from "zod";
/** Caller budgets bound decoding and the demand graph independently. */
export const nativeRegisterSliceInputSchema = z.strictObject({
  procedure: z.string().min(1),
  instruction: z.string().min(1),
  value: z.strictObject({
    register: z.string().regex(/^(r([0-9]|1[0-2])|sp|lr)$/u),
  }),
  when: z.literal("before"),
  max_instructions: z.number().int().positive().max(100000),
  max_operations: z.number().int().positive().max(1000000),
  max_nodes: z.number().int().positive().max(20000),
  max_edges: z.number().int().positive().max(40000),
});
export const sliceStorageSchema = z.strictObject({
  space: z.string(),
  offset: z.string().regex(/^0x[0-9a-f]+$/u),
  size: z.int().positive(),
});
export const sliceOperationSchema = z.strictObject({
  id: z.string(),
  instruction: z.string(),
  bytes: z.string(),
  opcode: z.string(),
  output: sliceStorageSchema.nullable(),
  inputs: z.array(sliceStorageSchema),
  successors: z.array(
    z.strictObject({ target: z.string(), predicate: z.string().nullable() }),
  ),
  unknown: z.string().nullable(),
});
export const nativeRegisterProgramSchema = z.strictObject({
  query: nativeRegisterSliceInputSchema,
  procedure: z.string(),
  instruction: z.string(),
  architecture: z.string(),
  register: sliceStorageSchema,
  seed: z.string(),
  entry: z.string(),
  seed_bytes: z.string(),
  operations: z.array(sliceOperationSchema),
  stop_reasons: z.array(z.string()),
  limitations: z.array(z.string()),
});
export const nativeRegisterSliceSchema = z.strictObject({
  query: nativeRegisterSliceInputSchema,
  procedure: z.string(),
  instruction: z.string(),
  architecture: z.string(),
  register: sliceStorageSchema,
  seed_bytes: z.string(),
  seed: z.string(),
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      position: z.string(),
      storage: sliceStorageSchema,
      kind: z.enum(["flow", "definition", "entry", "constant", "unknown"]),
      operation: sliceOperationSchema.nullable(),
      reason: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.strictObject({
      source: z.string(),
      target: z.string(),
      kind: z.enum(["flow", "input"]),
      predicate: z.string().nullable(),
    }),
  ),
  control_flow: z.array(
    z.strictObject({
      source: z.string(),
      target: z.string(),
      predicate: z.string().nullable(),
    }),
  ),
  reaching_definitions: z.array(z.string()),
  coverage: z.enum([
    "complete-within-model",
    "partial-budget",
    "partial-model",
  ]),
  unresolved: z.boolean(),
  stop_reasons: z.array(z.string()),
  assumptions: z.array(z.string()),
  limitations: z.array(z.string()),
  explanation: z.string(),
});
