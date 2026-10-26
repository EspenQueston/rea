# Browser saved values: integration verification

Executed on Linux x64, Node 24.22.1, Chromium through `/usr/bin/chromium`,
with PocketBase 0.40.6 on an owned loopback instance. Final measured runtime: `dd3085bf5a2511009116f2672d5aefa8e452537e`. Baseline: `6d5532a204b338a6c770fcbae61e0d55bda70793`. The imported implementation is
Edgar Arakelyan's PR #7162, upstream head
`d39f386d202fe8e98592fb2d9d26e43d8d0fb94f`; the subsequent upstream fixes through `81a275b130e85a40a227f6a61cfa2fe1162a217e`
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
  plaintext saved token or declared password. 7.553 s elapsed, 8.359 s CPU,
  1,424,781,312 bytes sampled process-family peak RSS.
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
| First task elapsed                                 |                  5.145 s |                  1.621 s |
| Warm task elapsed                                  |                  1.020 s |                  0.762 s |
| Entire verifier elapsed                            |                 11.723 s |                  7.653 s |
| Entire verifier CPU                                |                 13.444 s |                  8.683 s |
| Sampled process-family peak RSS                    |          2,028,253,184 B |          1,638,350,848 B |
| Input catalog + arguments/text replies, both tasks |  34,781 estimated tokens |  25,900 estimated tokens |
| Full SDK catalog + arguments/results, both tasks   | 368,391 estimated tokens | 351,500 estimated tokens |

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
No guard stopped these completed runs. An earlier pre-review pair at `355e2dcb8` gave 7.703→3.531 s first-task
latency, 1.390→1.605 s warm latency, and 14.990→17.198 s whole elapsed, so
the earlier warm and whole measurements did not improve. Its CPU was
15.735→15.679 s, family peak 2,080,378,880→1,636,233,216 B and model projection
34,899→25,897 estimated tokens. Both pairs remain observations; differences
reinforce host/cache variance rather than establishing universal speedups.

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

## Automated review follow-up

Seven reproductions failed against `275854261`: six noncanonical source JSON
spellings/duplicate fields and an ambiguous poll/click response selection. A
separate later-response escaped-string/exponent reproduction also failed before
the shared JSON-body correction. The owning response parser now supplies decoded
facts and original text together. A bounded `jsonc-parser` visitor replaces
sensitive value/key tokens without rebuilding unrelated numbers or whitespace;
JSON-labelled bodies use the same implementation for later responses. Bodies
with no active redactions avoid parsing, observed empty bodies stay empty, and
allocation admission precedes optional JSON decoding. Unreadable JSON remains
unavailable. Non-JSON byte bodies retain their existing spelling policy.

Real stdio MCP fetched an owned PocketBase static JSON fixture twice: the first
request saved a Unicode-escaped string and an exponent-spelled numeric secret,
and the second response exercised already-known secret handling. Both retained
bodies matched the exact expected redacted JSON bytes, preserving the unrelated
`1e-400` spelling. This non-vacuous two-body check passed in 6.806 s elapsed,
8.019 s CPU and 1,599,725,568 bytes sampled family peak RSS, with backend costs
unmeasured. It is a real HTTP/Chromium transport check over an owned fixture,
rather than a claim that PocketBase emits these spellings in its auth API.

To reproduce that additional check, place these exact bytes in the owned static
public directory as `escaped-values.json`, then run the existing verifier with
`--mode after --source-only` and a new output directory:

```text
{"token":"\u0073ource-token","code":1e3,"unknown":1e-400}
```

UI matching is explicitly observational. Requests already running are excluded;
multiple matches observed before binding, including while its body is pending,
refuse the binding. A matching method/path does not establish action causality,
and cannot exclude requests starting after that observation window. Choose a
selector distinct from background polling; no causal provenance is invented.

Derived Basic credentials now have bounded base64 construction and share the
single retained spelling budget, including deduplication. Create re-explanation
keeps only exemplars with unresolved string fields, charging request facts and
unique snapshot-array references before adoption; state-owned immutable entity
payloads retain their existing simulation-lifetime charges and are not rebilled.
The seven focused source suites passed **419 cases** after these changes, with
additional budget, late-ambiguity, escaped alias, empty-body and decoder-admission
coverage. Real Basic-auth server compatibility and real Grafana write inference
were not rerun; their encoding/accounting and inference semantics are covered by
source/boundary regressions and the attributed upstream evidence remains separate.

## CI baseline controls

The initial CI used synthetic merge `cbc8ba3379bc6dec457179ffdda7db033eae7dc2`
with main parent `dd7a2da5bb0c2e91d300dbaebd3a7aca8379a965`. All three
failing assertions were independently reproduced on that exact main parent:
the prewarm runner's 100 ms startup deadline assertion, and two SAZ tests that
expect no `partial_observation` although main retains source receipts. The SAZ
control had 16 passes, two failures and one skip; the isolated prewarm control
failed the same assertion. These source/control files are unchanged by this PR.
The initial real-browser, agentenv, static, documentation, package build and
Linux native baseline lanes passed. Cancelled shard coverage remains incomplete;
final CI/review outcomes and any authorized bypass are recorded in the PR.

## Source transaction publication follow-up

A later review identified two additional producing-boundary gaps: source URLs
could retain values learned only from their responses, and a declared whole
JSON string could span tokens rather than match an individual decoded value.
Three source-transaction regressions fail on `92b1f1cc8`; two spanning-secret
regressions fail before restoring the whole-body byte check.

The retained-event owner now finalizes only explicitly selected source
transaction IDs after network reads drain, including the source request's URL,
headers and already retained body. Unknown source values withhold the affected
URL/content and add a limitation. Replacements reserve working/retained capacity,
preserve sequence and transaction IDs, report omissions, and finalize once so
cleanup retry cannot repeat accounting. Same-URL unrelated transactions retain
their earlier facts. Two retained request identities suffice to detect UI
ambiguity; successful uniquely observed request bindings also establish privacy
readiness without requiring network body retention.

JSON decoding runs after event admission. Whole-body secret matching remains
alongside decoded-token matching; if a spanning replacement would break JSON,
the body is unavailable with a fixed diagnostic. The source-test run passed
**218 cases across seven browser/network/session suites**, including normal and
failed source reads, late response ambiguity, cleanup retry, capacity expansion,
shared-context ownership and the two whole-JSON cases. The prior CI's event
budget assertion exposed a stale byte-operation assumption; its replacement
checks both JSON processing and whole-body/MIME checks occur only for admitted
bodies, preserving its original no-work-for-omitted-content invariant.

The expanded real MCP source probe passed: two exact redacted source/later
bodies; an earlier source URL query containing the returned token; metadata-only
capture preserving the redacted source URL without retaining any content; and
an explicitly declared whole JSON payload seeded into local storage and POSTed
by the committed owned frontend. PocketBase returned **403**, retained request
body content was unavailable, the complete parent contained no payload token,
and the backend record count stayed unchanged. The probe took **9.200 s**,
**10.288 s CPU**, and **1,617,293,312 B** sampled family peak; backend costs remain
unmeasured. Serve `whole-json.html` alongside the original frontend when
reproducing `--source-only`. These are transport/retention checks on an owned
fixture, not claims of application-specific token issuance or Basic-auth support.
