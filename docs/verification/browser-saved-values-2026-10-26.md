# Browser saved values: integration verification

Executed on Linux x64, Node 24.22.1, Chromium through `/usr/bin/chromium`,
with PocketBase 0.40.6 on an owned loopback instance. Measured runtime: `355e2dcb8` (same browser implementation as the measured
uncommitted build). Baseline: `6d5532a204b338a6c770fcbae61e0d55bda70793`. The imported implementation is
Edgar Arakelyan's PR #7162, upstream head
`d39f386d202fe8e98592fb2d9d26e43d8d0fb94f`; The subsequent upstream fixes through `81a275b130e85a40a227f6a61cfa2fe1162a217e`
were compared during integration. Their numeric and slug semantics are retained
through existing shared owners; positive decimal cases are preserved; negative zero is refused by the shared
exact-number owner because serialization loses its sign. The
upstream compressed-body fallback is not enabled: this implementation requires
a known positive identity-encoded size before whole-body reads. Its historical evaluations are
attributed separately in the [original verification](../specs/agent-environments/scenario-saved-values/verification.md).

## Real application and independent oracle

The official PocketBase Linux amd64 release archive was 12,824,710 bytes,
SHA-256 `0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f`.
The [owned UI harness](https://github.com/morluto/rea/blob/355e2dcb8/experiments/analysis-efficiency/fixtures/browser-saved-values/index.html)
uses PocketBase's actual superuser authentication and record APIs. It is a
small test frontend, rather than PocketBase's complete administrative UI.
Collection `rea_items` has required text `title` and number `quantity` fields,
public list/view rules, and superuser-only create/update/delete rules.

The completed task signs in through the UI, creates a record, saves its generated
ID and numeric quantity, PATCHes the saved ID with a typed numeric JSON value,
GETs the same ID with a query, and navigates to its API URL. Independent public
PocketBase GETs verify final record identity, title and numeric quantity. Retained
request bodies independently check that the PATCH sent a number. Every scenario
step must complete, and the selected authentication response must actually occur
exactly once and contain a redacted token; absence would fail the oracle.

- Public CLI: all eight steps completed, with eight retained JSON bodies; no
  plaintext saved token or declared password. 4.881 s elapsed, 5.598 s CPU,
  1,349,656,576 bytes sampled process-family peak RSS.
- Public MCP: both first and subsequent tasks completed before and after. The
  baseline uses a retained event page to read the generated ID, then a second
  capture attached to the same browser. The candidate performs the same writes,
  reads and navigation in one capture using saved bindings.
- A real negative control against the imported implementation completed its
  actions but retained one plaintext authentication token in its source response.
  Integration protects the exact browser request before source headers or body
  can be retained. The corrected real CLI and MCP runs pass that oracle.

## Measured cost of the completed MCP tasks

Each column is one fresh MCP server and owned browser context, with a first
capture followed by a warm task. The browser has already loaded the fixture;
these are first-capture timings, not cold OS caches or cold browser startup.
One run per condition establishes observations, not statistical speed claims.

| Measurement                                        |                 Baseline |             Saved values |
| -------------------------------------------------- | -----------------------: | -----------------------: |
| Task calls, each completed task                    |                        3 |                        1 |
| First task elapsed                                 |                  7.703 s |                  3.531 s |
| Warm task elapsed                                  |                  1.390 s |                  1.605 s |
| Entire verifier elapsed                            |                 14.990 s |                 17.198 s |
| Entire verifier CPU                                |                 15.735 s |                 15.679 s |
| Sampled process-family peak RSS                    |          2,080,378,880 B |          1,636,233,216 B |
| Input catalog + arguments/text replies, both tasks |  34,899 estimated tokens |  25,897 estimated tokens |
| Full SDK catalog + arguments/results, both tasks   | 368,578 estimated tokens | 351,482 estimated tokens |

`o200k_base` BPE estimates serialize compact JSON; they are not model billing.
The model projection includes all 53 advertised tools' names, descriptions and
input schemas (18,579 tokens in either version), all arguments and text content.
The full SDK estimate also includes output schemas and structured results.
Both counts include the two extra Evidence exports used for correctness proof,
so eight total calls before and four after. Discovery retries, model reasoning,
JSON-RPC framing and SDK initialization traffic are not measured. No model ran.

Whole-verifier accounting includes discovery, browser setup, proof exports and
cleanup, and is deliberately distinct from timed analysis calls. The external
PocketBase server's CPU and memory are **unmeasured**. The REA/Chromium family
was restricted to two CPUs, a 3 GiB Node heap and an 8 GiB family RSS guard;
RSS was summed every 100 ms, may double-count shared pages and miss short peaks.
No guard stopped these completed runs. Warm latency and whole-verifier elapsed
did not improve; these measurements support fewer round trips and less context,
without establishing universal speed or memory improvements.

## Reproducing

Build each pinned checkout with the repository's pinned toolchain. On an owned
PocketBase 0.40.6 instance, create the collection and rules described above and a
temporary superuser. Serve the committed harness as its `--publicDir`. Put only
`{"email":"...","password":"..."}` in a private credentials JSON file; do not
commit or print it. Bind the server to `127.0.0.1`, use a disposable data directory,
and remove that directory after stopping its owned server.

Run the same candidate verifier against each built checkout:

```sh
node experiments/analysis-efficiency/browser-saved-values.mjs \
  --repository /absolute/path/to/checkout --mode before \
  --output /new/private/output-before --origin http://127.0.0.1:18762 \
  --credentials /private/credentials.json --browser /absolute/path/to/chromium
# Repeat with --mode after and a new --output for the candidate checkout.
```

Use a process-family resource profiler around the command. Output directories
are private and must be new. Full Evidence stays local: baseline responses can
contain authentication tokens. The shared verifier command owner closes the SDK
client and browser, preserves cleanup failures, and removes the profile only
after its owners release it. The disposable backend owns created records until
fixture teardown. This harness does not establish production-site behavior,
service-worker behavior, compressed UI response support, or other platforms.

## Regression evidence and limits

Ten source suites passed: **297 tests**, including request bindings, network
content, scenario finalization, provider ownership, canonical validation,
Evidence compatibility, and environment write inference. The previous four
upstream findings now have regressions: decoded-body admission, distinct retained
secret accounting, JSON numeric underflow, and applying held ampersand slug rules
to the first update. Ten request negative controls and six slug negative controls
failed against the imported production code before the fixes; the separate
unselected-inexact-field positive control passed. New network cases cover
headers-only source privacy, same-URL distinct request identity, and refusing
compressed/cache-unknown bodies without materializing them.

Failed attempts remain local: an early test command selected nonexistent paths;
one intermediate edit removed an adjacent write helper and was restored; deadline
fixtures initially used unknown body sizes, and one network refactor introduced
an unnecessary scheduling await. Final suites retain their original cancellation
assertions and pass. Real source-body privacy failed before the structural fix.
The five MCP boundary suites passed all 41 distinct cases across a combined run
and an isolated suite rerun. One case timed out at 30 seconds under contention
and passed in 17.36 seconds when isolated; an earlier invocation accidentally
used the older host Node and failed before executing tests. Documentation fact
checks, rendered documentation and formatting passed; a relative HTML fixture
link caught by the first documentation build was corrected.

Historical upstream multi-application/model results were not rerun. Required
integration gates and CI outcomes are recorded in the associated PR.
