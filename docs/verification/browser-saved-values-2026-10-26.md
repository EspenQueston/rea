# Browser saved values: integration verification

Executed on Linux x64, Node 24.22.1, Chromium through `/usr/bin/chromium`,
with PocketBase 0.40.6 on an owned loopback instance. Final measured runtime: `854b7a2c07f43f9145b2016c13e3a20a359a6ff2`. Baseline: `6d5532a204b338a6c770fcbae61e0d55bda70793`. The imported implementation is
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
  plaintext saved token or declared password. 5.478 s elapsed, 5.946 s CPU,
  1,352,437,760 bytes sampled process-family peak RSS.
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
| First task elapsed                                 |                  6.965 s |                  1.923 s |
| Warm task elapsed                                  |                  1.100 s |                  0.874 s |
| Entire verifier elapsed                            |                 15.657 s |                  9.213 s |
| Entire verifier CPU                                |                 17.222 s |                 10.753 s |
| Sampled process-family peak RSS                    |          2,053,414,912 B |          1,649,876,992 B |
| Input catalog + arguments/text replies, both tasks |  34,742 estimated tokens |  25,845 estimated tokens |
| Full SDK catalog + arguments/results, both tasks   | 368,315 estimated tokens | 351,400 estimated tokens |

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

The retained-event owner initially finalized selected source
transaction IDs after network reads drain, including the source request's URL,
headers and already retained body. Unknown source values withhold the affected
URL/content and add a limitation. Replacements reserve working/retained capacity,
preserve sequence and transaction IDs, report omissions, and finalize once so
cleanup retry cannot repeat accounting. The final revision additionally
rechecks retained network facts against all known marked values, including
follow-up transactions captured before response-secret admission completed.
Unknown source values withhold only the selected source transaction.
Two retained request identities suffice to detect UI
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

## Final main integration and measurements

Main `19b2972df` (the tested merge commit is `419dd1900`) was integrated before the final checks. The only
conflict was two appended test groups; both were retained. The author's
subsequent updates through `22a93fadc` were compared: malformed UTF-8 was
already refused by the shared decoder; its encoded-spelling lower-bound
admission is now reused before allocating rejected encoded copies. A million
Unicode characters exceed the budget without invoking the URI encoder or
changing the saved bindings. All **524 tests in 11 focused source suites**,
type/lint and the runtime build passed on this final main integration.

The expanded real source probe repeated successfully on final runtime
`e7acc5d85`: **14.628 s** elapsed, **16.015 s CPU**, **1,607,163,904 B**
sampled family peak. The metadata-only and whole-JSON checks also passed,
including the integer backend-count oracle. The main task table above is the
final pair against the pinned pre-feature baseline. Earlier post-review pairs
remain relevant observations rather than discarded slower attempts:

| Candidate   | First task before→after s | Warm task before→after s | Whole elapsed before→after s | Whole CPU before→after s |
| ----------- | ------------------------: | -----------------------: | ---------------------------: | -----------------------: |
| `dd3085bf5` |               5.145→1.621 |              1.020→0.762 |                 11.723→7.653 |             13.444→8.683 |
| `439a389fe` |              16.121→4.429 |              2.944→1.738 |                34.296→20.053 |            32.166→19.053 |

The second CI run also caught an own-PR event-budget assertion about the old
byte-only processing path. It was corrected together with moving optional JSON
processing after event admission and retaining the required whole-body check;
its original capacity/coverage assertions remain. That failure is distinct from
the independently reproduced main prewarm/SAZ failures and is not bypassed.

## Final automated review: URL boundaries, follow-ups and expansion

Runtime `43aaaabbe` fixes three additional actionable findings. Saved URL
segments recognize both slash and literal backslash boundaries, preserving
caller spelling while rejecting substituted dot segments before navigation or
request dispatch. Two regression cases fail on `9920a9a39`.

The retained-event owner applies the final known secret set to network metadata,
headers and both body phases before publication. A deterministic follow-up
transaction records its URL, headers and both bodies before the source response
finishes; it leaks on `9920a9a39` and is protected by the final revision. The
pass is bounded by existing working/retained budgets and remains idempotent on
cleanup retry. It reuses retained bytes and does not make new target requests.

Request serialization has a pre-allocation allowance derived from V8 available
heap and Node's string ceiling, with a conservative factor of 16 for expanded
values and transport copies. JSON accounting includes escaping and measures
repeated saved values once per request. URL interpolation and the complete
request envelope, including headers, are also admitted before dispatch.
Four cases reject 1,000 references to a 3,000,000-character saved value in arrays,
embedded strings, URLs and headers without browser dispatch. These oversized
cases were deliberately not run against unbounded production code. The first
header guard took 4.042 seconds in its source test; repeated header validation
and size scans now share request-local facts, and the final case no longer appears in the slow-test output
(the final individual duration was not separately measured). This is a local observation, not a
general latency claim or a measurement of peak allocation avoided.

All **531 cases in 11 source suites**, type/lint and the runtime build passed
on the final production revision. The real source probe now also exercises the
committed `immediate-followup.html`: the page consumes the selected JSON and
immediately POSTs its token to PocketBase in a query, header and JSON body.
Both initial attempts encountered a cached response with unknown decoded size;
the operation correctly refused to read it. The fixture now explicitly requests
`cache: "no-store"`, and all four real privacy cases pass. This retains the
known-size requirement rather than enabling unbounded cache reads.

CI on `9920a9a39` passed source tests, static checks, documentation, package build
and real-browser verification. Portable output contains 29,596 passes and three
failures: two SAZ partial-observation assertions and a Java probe diagnostic
assertion. The two SAZ failures independently reproduce on the exact synthetic
merge main parent `52414282b`; its isolated prewarm control passes. Cancelled
shards remain incomplete even where they emitted passing test summaries.

The final four-case real privacy probe passed in **9.675 s elapsed**, **11.092 s
CPU**, with **1,639,161,856 B** sampled process-family peak. The final CLI and
paired MCP measurements are in the primary tables. The preceding `e7acc5d85`
pair remains an observation: first task 10.778→2.627 s, warm 1.467→1.129 s,
whole elapsed 22.310→12.661 s, CPU 26.148→14.759 s, family peak
2,103,361,536→1,631,567,872 B, model estimate 34,831→25,902 tokens.

The Java diagnostic assertion also fails independently on `52414282b`
(`keeps empty Java bitness unresolved`); the expected diagnostic includes the
empty source spelling, while main returns only “bitness unknown”. All three
portable failures on `9920a9a39` therefore reproduce on its actual main parent.

## Final event privacy and response-path ownership

Runtime `854b7a2c0` separates learned redaction facts from source request
readiness. The secret owner records actual runtime admission; source identity
still independently controls withholding. Metadata-only direct requests can
therefore learn a secret even when multiple identical source requests prevent
attribution. The final event pass also handles typed console, page-error,
WebSocket text/URLs, frame/worker/popup names and URLs, and download metadata.
It preserves event identity and observed payload byte counts, admits replacement
working/retained cost, and reports omissions once on cleanup retry. It runs
without network selection when runtime secrets were learned.

Whole HTTP response-path normalization now precedes segment matching. A
collision-free temporary marker preserves only explicit `{*}` segments;
literal encoded braces remain literal, and backslashes plus plain/encoded dot
segments follow the browser URL parser. Five new negative controls fail on
`12534c95e` before these changes. Additional cases preserve literal-marker
paths, distinguish encoded braces, and verify bounded late text expansion.
All **539 source cases in 11 suites**, type/lint and the runtime build passed.

The owned immediate-follow-up page also logs the response token before its
POST. Real MCP Evidence retains exactly one redacted console event and contains
no original token in retained event text; the decoded POST body, URL and header
checks also pass. All four privacy cases complete in **8.808 s elapsed**,
**10.241 s CPU**, **1,625,501,696 B** sampled family peak. The final CLI and MCP
pair are in the primary table. The prior `43aaaabbe` pair remains an observation:
first task 7.751→3.220 s, warm 1.210→0.996 s, whole elapsed 15.527→11.301 s,
CPU 18.047→12.777 s, peak 2,064,392,192→1,627,856,896 B, model estimate
34,816→25,866 tokens. These repeated small runs do not establish universal
performance or full OS-cache coldness.

CI on `12534c95e` passed source/static/docs/build and real-browser lanes. Its
portable output contains 27,517 passes and one failure: the same Java diagnostic
assertion independently reproduced on its actual main parent `60834e391`.
Cancelled shards are incomplete; this does not establish whether the earlier
SAZ failures were fixed or merely unexecuted in that run.
