# Solana sBPF program analysis

`analyze_solana_program` / `analyze-solana-program` analyzes one Solana
program (sBPF ELF) from an explicitly selected source: a local ELF file, or a
program id fetched read-only through Solana JSON-RPC. It does not require an
active native binary target, never executes the program, and never builds,
signs, or broadcasts a transaction.

```sh
rea analyze-solana-program --elf ./pump_amm.so --json
rea analyze-solana-program --program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA --out ./pump_amm --json
rea analyze-solana-programs --elf ./pump.so --elf ./pump_amm.so --out ./batch --json
rea analyze-solana-programs --dir ./captures --out ./batch --json
```

`analyze_solana_programs` / `analyze-solana-programs` runs the same
single-program workflow over a mixed list of local ELFs and program ids
(CLI: repeatable `--elf` / `--program`, or `--dir` for a directory of
`.so` files) with bounded concurrency (default 4, cap 8). Each item lands
in `<out_dir>/<name>/` with the single mode's artifacts; one bad item
yields an error entry and never sinks the batch. `<out_dir>/index.json`
records, per item: source, artifact SHA-256, slot when fetched,
handler-candidate count, dispatch coverage, per-item analysis path, and
status or error.

```json
{
  "name": "analyze_solana_program",
  "arguments": {
    "program_id": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "out_dir": "/artifacts/pump_amm"
  }
}
```

## Intake

- `--elf <path>` analyzes the exact selected file. Path resolution failures
  (`ENOENT`, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG`) are `invalid_request` issues;
  permission failures keep their own classification. Intake is bounded to
  64 MiB.
- `--program <id>` performs `getAccountInfo` at finalized commitment against
  `rpc_url`, `REA_SOLANA_RPC_URL`, or the public mainnet endpoint, in that
  order. BPF Loader Upgradeable programs resolve through their ProgramData
  account (tag 3 header: slot, optional upgrade authority, then the ELF);
  legacy-loader accounts holding an ELF directly are accepted as-is. The
  fetched ELF is materialized as `<out_dir>/<program_id>.so` and analyzed as
  that local file, so both modes share one artifact identity semantics.
  `out_dir` is therefore required with `--program`.
- When `out_dir` is selected in either mode, the provider also writes
  `solana-analysis.json` (the Evidence result) and `disassembly.txt` (the
  full linear-sweep disassembly) there.

## Evidence semantics

- Artifact SHA-256 covers the whole selected file, including any trailing
  account-capacity padding; `elf.trailing_bytes` reports how much of the file
  lies beyond the extents its ELF headers declare.
- ELF facts (class, byte order, machine, entrypoint, sections), dynamic
  symbols, and byte identity are observations. The record is nevertheless
  labeled `inferred`, because its headline output — the handler table — is
  inference.
- Handler candidates come from the dispatch idioms the analyzer can
  verify, each labeled by `method`:
  - `lddw-compare`: a 64-bit constant loaded by `lddw` and consumed, before
    any overwrite, by a nearby register-register `jeq`/`jne`. That is the
    shape Anchor/rustc emits for instruction dispatch. The candidate
    records the discriminator (the constant's little-endian bytes), the
    constant and comparison addresses, and the branch target.
  - `split-compare`: the discriminator compared as two 32-bit halves —
    loads from `[base + 0]` and `[base + 4]` checked against immediates
    whose composed value is the discriminator, both guarding one handler
    (both bail to one skip target, or the low half bails and the high half
    branches in). Records both comparison addresses and the composed
    discriminator.
  - `table-dispatch`: a register-indirect transfer whose register was
    loaded from a read-only table of `.text` addresses at a constant
    base. Records the table address, the slot (`index:n` label), and the
    entry target; discriminator is null.
- The `dispatch` coverage block counts candidates by method and the
  register-indirect transfers that matched no verified idiom
  (`computed_jumps_unresolved`).
- Syscall surface is the ELF's undefined dynamic symbols (`sol_*` names)
  plus per-call-site resolution. A `call` immediate resolves only when it
  verifies: an `R_BPF_64_32` relocation naming the site (captured ELFs carry
  the `-1` placeholder at syscall sites; the relocation names the import),
  exactly one Murmur3-32 hash candidate across the canonical syscall
  registry and the ELF's own imports, or a pc-relative target landing
  exactly on a defined symbol. Each site records its resolution basis;
  unresolved sites keep the raw immediate.
- Disassembly is a linear sweep by the bundled sBPF decoder
  (`rea-sbpf-decoder`). It is not a Ghidra/IDA-grade lift: no control-flow
  recovery, Rust source, types, or account layouts are produced.

## Limitations

- Dispatch idioms outside the three recovered shapes (and computed jumps
  whose tables cannot be verified) stay unresolved and are counted, not
  guessed; an empty handler list does not prove a program has no callable
  interface.
- A fetched program reflects the endpoint's finalized state at call time; it
  may differ from an earlier capture if the program was upgraded.
- Discriminator candidates are reconstruction leads. Behavior parity with a
  deployed program is established only by differential tests against the
  captured original (the pumpfun-source model), never by this scan alone.
