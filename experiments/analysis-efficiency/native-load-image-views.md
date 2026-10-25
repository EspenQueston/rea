# Native load-image delivery verification

`native-load-image-views.mjs` runs the compiled production stdio MCP server with
a caller-selected Ghidra and JDK. It compares complete delivery with a summary
plus selected relocation pages, then exports and authenticates the complete
parent. Every call uses its actual advertised SDK contract. Both cold and warm
reads run in one fresh server; OS file caches are not declared cold.

Build each selected runtime with the pinned toolchain. Use absolute paths or
paths relative to the verifier's launch directory, and new output directories:

```sh
node experiments/analysis-efficiency/native-load-image-views.mjs \
  --runtime /path/to/baseline --mode complete \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --ghidra /path/to/ghidra_12.1.4_PUBLIC --java /path/to/jdk-21 \
  --output /new/baseline-report
node experiments/analysis-efficiency/native-load-image-views.mjs \
  --runtime /path/to/feature --mode summary \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --ghidra /path/to/ghidra_12.1.4_PUBLIC --java /path/to/jdk-21 \
  --output /new/summary-report --control /new/baseline-report
```

The question is the verification state, all collection counts, and the first
four relocation addresses/statuses. The summary path additionally checks the
last relocation's recorded bytes and unavailable independent verification
checks. It never treats ELF observations as verified. Complete delivery can
exceed the MCP response limit: the baseline then follows the reported retained
reference, exports its source and selects facts locally. That recovery is an
extra workflow, not a successful complete inline MCP reply. Include its calls
and local reads when comparing completed tasks.

The independent GNU `readelf -Wr` oracle checks that every file-table relocation
coordinate survives, including multiplicity. `readelf -Wl` supplies the original
PT_LOAD base independently of Ghidra's chosen import base. Producer order can
differ. Additional provider observations are retained and reported separately;
this oracle does not independently verify their origin. Full observation
digests and selected facts must agree with the control run.

The target SHA-256, native oracle output, raw catalog, arguments/replies,
complete Evidence and phase durations stay in the output directory. Measure
whole-process-family elapsed time, CPU and peak memory externally, with bounded
CPU/heap and a memory stop condition. The child requests a 1.5 GiB Ghidra heap
and a 3 GiB Node heap; neither is a whole-family RSS bound. Estimate tokens over
catalog discovery, arguments, all replies and local recovery facts using a named
tokenizer. Raw serialized schema estimates are not actual model usage; protocol
framing, prompts and client rendering remain unmeasured.

The shared receipt finalizer closes both transports, removes its owned workspace
after successful cleanup, and preserves cleanup/publication failures in the
report. Its phase elapsed field precedes final receipt publication; external
whole-family measurements must include that finalization.
