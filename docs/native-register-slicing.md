# Native register backward slices

`slice_native_register` asks which values can supply a physical register immediately before one instruction in an explicit function. It uses instruction-level p-code and its control-flow successors. It does not search disassembly text or infer a physical register boundary from optimized high p-code.

```json
{
  "procedure": "0x1000",
  "instruction": "0x1004",
  "value": { "register": "r0" },
  "when": "before",
  "max_instructions": 80,
  "max_operations": 1000,
  "max_nodes": 300,
  "max_edges": 600,
  "detail": "summary"
}
```

The initial provider is Ghidra with language `ARM:LE:32:v7`, known ARM mode, four-byte instructions and no delay slots. Thumb and other language profiles are unsupported. Query registers are `r0` through `r12`, `sp` and `lr`. The tool requires an exact instruction boundary inside the selected function. It verifies that captured analyzed instruction bytes equal their original file-backed bytes. Relocated or ambiguously mapped instructions are rejected.

The default response is a compact deterministic explanation and graph counts. Complete Evidence remains in the current session, with target digest, provider identity and analysis-profile commitment supplied by the existing Evidence machinery. Use the summary's `parent_evidence_id` with `inspect_analysis_view` and this view to read graph pages:

```json
{
  "kind": "native-register-slice",
  "collection": "nodes",
  "offset": 0,
  "limit": 64
}
```

Collections are `nodes`, `edges` and `control_flow`. `detail: "complete"` returns the complete bounded slice inline. Evidence also retains the raw captured p-code used to derive the result. A CLI summary requires the existing Evidence bundle delivery options so it survives the one-shot session.

## Interpretation

Nodes identify a storage range at a p-code boundary. Backward flow edges preserve all captured predecessors reachable from the function entry. A matching write supplies a definition; its operands become dependencies at the boundary before that write. Interned states terminate traversal and preserve cycles. The separate control-flow collection retains branch alternatives leading to the query, including predicates before a definition.

Instruction-local p-code branches preserve ARM predication. A skipped write follows its incoming value. Function-entry dependencies remain symbolic and are not automatically identified as parameters. Integer arithmetic and copies retain their operands without claiming numerical evaluation or feasible execution paths.

Loads retain address operands, with unresolved loaded contents. Stores do not resolve later loads, including stack spills and reloads. Calls produce unknown register effects; no ABI preservation is assumed. Unsupported p-code operations conservatively stop value traversal with an unknown. Partial or overlapping register writes remain unresolved rather than pretending to preserve a full register.

`coverage` distinguishes a complete traversal within the supported model, a budget cutoff and incomplete control-flow capture. `unresolved` independently reports semantic uncertainty. A complete traversal can still contain an unresolved load or call. An empty definition list with a cutoff is not evidence that no origin exists. Syntactic reachability does not prove path feasibility, pointer initialization, object membership or lifetime.

## Budgets and implementation

`max_instructions` and `max_operations` replace a block budget: a single basic block can contain arbitrarily many instructions and p-code operations. Both must be explicit, as must `max_nodes` and `max_edges`. The graph edge budget includes backward dependencies and retained control-flow edges. The implementation reports the limiting budget and preserves the partial graph. Existing provider request deadlines and cancellation still apply.

The Ghidra bridge captures raw operations, physical storage, exact instruction bytes and p-code control flow. The adapter validates that producer contract. The domain traversal derives reaching definitions. Existing official tool registration, CLI execution, Evidence retention, target/profile binding and analysis-view pagination deliver the result. No high-p-code graph, disassembler, model call or generic graph framework is added.

Synthetic ARM words are authored in `scripts/fixtures/native/register-slice.mjs`. `ReaRegisterSliceProbe.java` exercises the production bridge against those bytes. Domain tests independently specify constants, alternative definitions, entry dependencies, cutoffs and unresolved cases. Module tests alone do not establish Ghidra behavior. Verification results must identify the actual Ghidra lane and source revision.

## Reproduce the provider checks

After `npm run build:cached`, run these commands on an authorized Ghidra host. Use a fresh output directory; the generated fixture and result files must not already exist. `GHIDRA_INSTALL_DIR` must identify an existing installation.

```sh
mkdir -p build/register-slice/project
node scripts/fixtures/native/register-slice.mjs build/register-slice/arm.bin
"$GHIDRA_INSTALL_DIR/support/analyzeHeadless" "$PWD/build/register-slice/project" Slice \
  -import "$PWD/build/register-slice/arm.bin" -loader BinaryLoader -loader-baseAddr 0x1000 \
  -processor ARM:LE:32:v7 -noanalysis -readOnly -deleteProject \
  -scriptPath "$PWD/tests/conformance/ghidra;$PWD/bridge/ghidra" \
  -postScript ReaRegisterSliceProbe.java "$PWD/bridge/ghidra" "$PWD/build/register-slice/capture.json"
node scripts/verify/ghidra/register-slice-results.mjs build/register-slice/capture.json build/register-slice/results.json
node scripts/verify/ghidra/register-slice-mcp.mjs build/register-slice
```

Require all three explicit success markers: `REA_REGISTER_SLICE_CAPTURE_OK`, `REA_REGISTER_SLICE_RESULTS_OK` and `REA_REGISTER_SLICE_MCP_OK`. Ghidra's process can exit successfully after a script exception, so its exit code alone is insufficient. The MCP verifier retains `retained-example.json` with the exact query, compact receipt, complete Evidence and a graph page. It verifies the target digest, profile commitment, byte evidence, retention linkage and invalid boundary rejection.
