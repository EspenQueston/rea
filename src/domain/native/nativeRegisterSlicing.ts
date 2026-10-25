import type { z } from "zod";
import type {
  nativeRegisterProgramSchema,
  nativeRegisterSliceSchema,
  sliceStorageSchema,
} from "./nativeRegisterSlice.js";

type Program = z.infer<typeof nativeRegisterProgramSchema>;
type Slice = z.infer<typeof nativeRegisterSliceSchema>;
type Storage = z.infer<typeof sliceStorageSchema>;
const key = (s: Storage) => `${s.space}:${s.offset}:${s.size}`;
const overlaps = (a: Storage, b: Storage) =>
  a.space === b.space &&
  BigInt(a.offset) < BigInt(b.offset) + BigInt(b.size) &&
  BigInt(b.offset) < BigInt(a.offset) + BigInt(a.size);

const describeOrigin = (node: Slice["nodes"][number] | undefined): string => {
  if (!node) return "unrecorded origin";
  if (node.kind === "entry") return "symbolic function-entry register value";
  if (node.kind === "unknown") return node.reason ?? "unknown origin";
  const operation = node.operation;
  if (!operation) return node.kind;
  const literal =
    operation.opcode === "COPY" && operation.inputs[0]?.space === "const"
      ? ` of ${operation.inputs[0].offset}`
      : "";
  return `${operation.opcode}${literal} at ${operation.instruction}${node.reason ? ` (${node.reason})` : ""}`;
};

/** Demand-driven reaching definitions over raw p-code positions. Visited states retain cycles. */
export const sliceNativeRegister = (program: Program): Slice => {
  const operations = new Map(program.operations.map((op) => [op.id, op]));
  const reachable = new Set<string>();
  const queue = [program.entry];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of operations.get(id)?.successors ?? [])
      queue.push(edge.target);
  }
  const predecessors = new Map<
    string,
    { source: string; predicate: string | null }[]
  >();
  for (const op of program.operations.filter((op) => reachable.has(op.id)))
    for (const edge of op.successors) {
      const incoming = predecessors.get(edge.target) ?? [];
      incoming.push({ source: op.id, predicate: edge.predicate });
      predecessors.set(edge.target, incoming);
    }
  const nodes: Slice["nodes"] = [];
  const edges: Slice["edges"] = [];
  const seen = new Map<string, Slice["nodes"][number]>();
  const pending: Slice["nodes"] = [];
  const stops = new Set(program.stop_reasons);
  const intern = (position: string, storage: Storage) => {
    const id = `${position}/${key(storage)}`;
    const prior = seen.get(id);
    if (prior) return prior;
    if (nodes.length >= program.query.max_nodes) {
      stops.add("max_nodes");
      return undefined;
    }
    const node: Slice["nodes"][number] = {
      id,
      position,
      storage,
      kind: "flow",
      operation: null,
      reason: null,
    };
    seen.set(id, node);
    nodes.push(node);
    pending.push(node);
    return node;
  };
  const seed = intern(program.seed, program.register);
  // Retain control alternatives independently of where value traversal stops at a write.
  const control_flow: Slice["control_flow"] = [];
  const ancestors = new Set<string>();
  const controlQueue = [program.seed];
  for (let i = 0; i < controlQueue.length; i++) {
    const id = controlQueue[i];
    if (!id || ancestors.has(id)) continue;
    ancestors.add(id);
    for (const edge of predecessors.get(id) ?? []) {
      if (control_flow.length >= program.query.max_edges) {
        stops.add("max_edges");
        break;
      }
      control_flow.push({
        source: edge.source,
        target: id,
        predicate: edge.predicate,
      });
      controlQueue.push(edge.source);
    }
    if (control_flow.length >= program.query.max_edges) break;
  }
  const link = (
    source: Slice["nodes"][number],
    position: string,
    storage: Storage,
    kind: "flow" | "input",
    predicate: string | null,
  ) => {
    if (edges.length + control_flow.length >= program.query.max_edges) {
      stops.add("max_edges");
      return;
    }
    const target = intern(position, storage);
    if (target)
      edges.push({ source: source.id, target: target.id, kind, predicate });
  };
  if (seed && program.limitations.length > 0) {
    const unknown = intern("unknown-control-flow", program.register);
    if (unknown) {
      unknown.kind = "unknown";
      unknown.reason =
        "Captured control-flow coverage is incomplete; additional origins may exist";
      if (edges.length + control_flow.length < program.query.max_edges)
        edges.push({
          source: seed.id,
          target: unknown.id,
          kind: "flow",
          predicate: null,
        });
      else stops.add("max_edges");
    }
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const node = pending[cursor];
    if (!node) break;
    if (node.kind === "unknown") continue;
    if (node.storage.space === "const") {
      node.kind = "constant";
      continue;
    }
    // 'after:' states apply a definition; ordinary states denote the boundary before an op.
    if (node.position.startsWith("after:")) {
      const op = operations.get(node.position.slice(6));
      if (!op) {
        node.kind = "unknown";
        node.reason = "Missing operation";
        continue;
      }
      node.operation = op;
      if (op.unknown !== null) {
        node.kind = "unknown";
        node.reason = op.unknown;
        continue;
      }
      if (op.output && overlaps(op.output, node.storage)) {
        node.kind = "definition";
        if (key(op.output) !== key(node.storage)) {
          node.kind = "unknown";
          node.reason =
            "Overlapping storage write requires unresolved byte composition";
        }
        if (op.opcode === "LOAD")
          node.reason =
            "Loaded contents and aliases unresolved; inputs describe the address, not object validity";
        for (const input of op.inputs) link(node, op.id, input, "input", null);
      } else link(node, op.id, node.storage, "flow", null);
      continue;
    }
    if (node.position === program.entry && node.storage.space === "register") {
      // Entry is also a join when a back edge reaches the function entry.
      const entry = intern("entry", node.storage);
      if (entry) {
        entry.kind = "entry";
        if (edges.length + control_flow.length < program.query.max_edges)
          edges.push({
            source: node.id,
            target: entry.id,
            kind: "flow",
            predicate: "function entry",
          });
        else stops.add("max_edges");
      }
    }
    if (node.position === "entry") {
      node.kind = "entry";
      continue;
    }
    const incoming = predecessors.get(node.position) ?? [];
    if (
      incoming.length === 0 &&
      (node.position !== program.entry || node.storage.space !== "register")
    ) {
      node.kind = "unknown";
      node.reason = "Missing predecessor or unreachable instruction";
    }
    for (const edge of incoming) {
      const op = operations.get(edge.source);
      if (
        node.storage.space === "unique" &&
        op?.instruction !== operations.get(node.position)?.instruction
      ) {
        node.kind = "unknown";
        node.reason = "Instruction-local temporary has no definition";
        continue;
      }
      link(node, `after:${edge.source}`, node.storage, "flow", edge.predicate);
    }
  }
  const definitions = new Set<string>();
  const walked = new Set<string>();
  const roots = seed ? [seed.id] : [];
  const outgoing = new Map<string, Slice["edges"]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  for (let i = 0; i < roots.length; i++) {
    const id = roots[i];
    if (!id || walked.has(id)) continue;
    walked.add(id);
    const node = seen.get(id);
    if (!node) continue;
    if (node.kind !== "flow") definitions.add(id);
    else
      for (const edge of outgoing.get(id) ?? [])
        if (edge.kind === "flow") roots.push(edge.target);
  }
  const unresolved =
    nodes.some((n) => n.kind === "unknown" || n.reason !== null) ||
    program.limitations.length > 0;
  return {
    query: program.query,
    procedure: program.procedure,
    instruction: program.instruction,
    architecture: program.architecture,
    register: program.register,
    seed_bytes: program.seed_bytes,
    seed: seed?.id ?? "",
    nodes,
    edges,
    control_flow,
    reaching_definitions: [...definitions],
    coverage: stops.size
      ? "partial-budget"
      : program.limitations.length
        ? "partial-model"
        : "complete-within-model",
    unresolved,
    stop_reasons: [...stops],
    limitations: program.limitations,
    assumptions: [
      "Intraprocedural syntactic reachability; path feasibility is not proved",
      "Memory loads remain unresolved, including stack reloads",
      "Calls have unknown effects on all register storage; no calling convention is assumed",
      "Function-entry values are symbolic, not parameter bindings",
    ],
    explanation: `${definitions.size} possible origin(s): ${[...definitions].map((id) => describeOrigin(seen.get(id))).join("; ") || "none recorded"}. ${stops.size ? "Analysis stopped at an explicit budget; additional origins may exist." : program.limitations.length ? "Control-flow coverage is incomplete; additional origins may exist." : "Traversal completed within the captured model."} ${unresolved ? "Semantic dependencies remain unresolved." : "No unresolved semantic dependency was encountered."}`,
  };
};
