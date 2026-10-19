// Synthetic fault injection through the actual transports and process owner.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { resolvedAnalysisError } from "../../dist/domain/analysisErrorBase.js";
import { probe, retryCleanup } from "./probe.mjs";
import { createAnalysisExperiment } from "./analysis.mjs";
import { viewObservation } from "./analysis-view.mjs";
import { retryNativeByteCleanup } from "./native-bytes.mjs";

const root = await mkdtemp(join(tmpdir(), "rea-transport-faults-"));
const executable = join(root, "fault-provider");
before(async () => {
  await runOwnedCommand(
    {
      command: process.env.CC ?? "cc",
      arguments: [
        fileURLToPath(new URL("./transport-fault-fixture.c", import.meta.url)),
        "-o",
        executable,
      ],
      runId: randomUUID(),
    },
    { timeoutMs: 30_000, diagnosticBytes: 1024 * 1024 },
  );
});
after(async () => {
  assert.equal(await retryCleanup(), 0);
  await rm(root, { recursive: true, force: true });
});

function fixture(transport, mode) {
  const ready = join(root, randomUUID());
  return {
    ready,
    connection: { transport, path: executable, executable },
    options: {
      timeoutMs: 5_000,
      environment: {
        ...process.env,
        REA_FAULT_MODE: mode,
        REA_FAULT_TRANSPORT: transport,
        REA_FAULT_READY: ready,
      },
    },
  };
}
async function waitReady(path, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    await delay(10);
  }
  throw new Error("Fault provider did not start");
}
function cleaned(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
  const diagnostics = result.error.partialObservation.transcript.find(
    (entry) => entry.provider_diagnostics,
  );
  assert.ok(diagnostics);
  const { exitCode, signal } = diagnostics.provider_diagnostics;
  assert.ok(Number.isInteger(exitCode) || typeof signal === "string");
}

for (const transport of ["r2pipe", "r2mcp"]) {
  test(`${transport}: interrupted partial frame retains exact bytes and cleanup`, async () => {
    const { connection, options, ready } = fixture(transport, "partial");
    const controller = new AbortController();
    const pending = probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: controller.signal },
    );
    await waitReady(ready);
    await delay(100);
    controller.abort();
    const result = await pending;
    cleaned(result);
    const frame =
      result.error.partialObservation.provider_partial.unterminated_frame;
    assert.equal(frame.invalid_utf8, true);
    assert.deepEqual(
      Buffer.from(frame.base64, "base64"),
      Buffer.concat([Buffer.from('{"res":"partial-'), Buffer.from([255])]),
    );
    assert.equal(result.error.partialObservation.completion, "unknown");
  });
}

test("captured environments replace ambient variables on every owned transport", async () => {
  const previous = process.env.REA_FAULT_OMITTED;
  process.env.REA_FAULT_OMITTED = "synthetic-ambient-value";
  try {
    for (const transport of ["exec", "r2pipe", "r2mcp"]) {
      const { connection, options, ready } = fixture(transport, "environment");
      delete options.environment.REA_FAULT_OMITTED;
      options.environment.REA_FAULT_SELECTED = "caller-selected";
      options.environment.REA_FAULT_ENV_REPORT = ready + ".environment";
      await probe({ ...connection, commands: ["ij"] }, options);
      assert.equal(
        await readFile(ready + ".environment", "utf8"),
        "absent\ncaller-selected\n",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.REA_FAULT_OMITTED;
    else process.env.REA_FAULT_OMITTED = previous;
  }
});

for (const transport of ["exec", "r2pipe"]) {
  test(`${transport}: failed cleanup stops the batch, blocks admission and resolves returned errors on retry`, async (context) => {
    const { connection, options } = fixture(transport, "completed");
    const owners = new Set();
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function () {
        owners.add(this);
        this.unref();
        return { status: "incomplete", reason: "injected cleanup denial" };
      },
    );
    try {
      const result = await probe(
        {
          ...connection,
          commands: transport === "exec" ? ["ij", "ij"] : ["ij"],
        },
        options,
      );
      assert.equal(result.ok, false);
      assert.equal(owners.size, 1);
      assert.equal(
        projectAnalysisError(result.error).code,
        "cleanup_incomplete",
      );
      const blocked = await probe({ ...connection, commands: ["ij"] }, options);
      assert.equal(blocked.ok, false);
      assert.equal(owners.size, 1);
      assert.equal(
        projectAnalysisError(blocked.error).code,
        "cleanup_incomplete",
      );
      assert.ok(result.error.cleanupResources.length);
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
      for (const failure of [result.error, blocked.error]) {
        assert.equal(failure.cleanupIncomplete, false);
        assert.notEqual(
          projectAnalysisError(failure).code,
          "cleanup_incomplete",
        );
      }
      assert.equal(
        (await probe({ ...connection, commands: ["ij"] }, options)).ok,
        true,
      );
    } finally {
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
    }
  });
}

test("frame and transcript capacity failures preserve their tag, limits and partial observations", async () => {
  const { connection, options } = fixture("r2pipe", "overflow");
  const frame = await probe({ ...connection, commands: ["ij"] }, options);
  assert.equal(frame.error._tag, "AnalysisResourceConstraintError");
  assert.equal(frame.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
  assert.ok(
    frame.error.partialObservation.provider_partial.unterminated_frame.bytes >
      0,
  );
  const exec = fixture("exec", "overflow");
  const output = await probe(
    { ...exec.connection, commands: ["ij"] },
    exec.options,
  );
  assert.equal(output.error._tag, "AnalysisResourceConstraintError");
  assert.equal(
    output.error.partialObservation.provider_partial.diagnosticTruncated,
    true,
  );
  let responseMiB = 9;
  const server = createServer((_request, response) =>
    response.end(
      JSON.stringify({
        error: false,
        code: 0,
        res: "x".repeat(responseMiB * 1024 * 1024),
      }),
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probe({
      transport: "http",
      endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      commands: ["ij"],
    });
    assert.equal(result.error._tag, "AnalysisResourceConstraintError");
    assert.equal(result.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
    assert.ok(result.error.partialObservation.transcript.length);
    assert.equal(
      projectAnalysisError(result.error).details.reported_limits.max_bytes,
      16 * 1024 * 1024,
    );
    responseMiB = 17;
    const oversized = await probe({
      transport: "http",
      endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      commands: ["ij"],
    });
    assert.equal(oversized.error._tag, "AnalysisResourceConstraintError");
    assert.equal(oversized.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
    assert.ok(
      oversized.error.partialObservation.provider_partial.output.bytes > 0,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cancellation during failed process cleanup preserves its exact reason after retry", async (context) => {
  for (const transport of ["exec", "r2pipe"]) {
    const { connection, options } = fixture(transport, "completed");
    const controller = new AbortController();
    const reason = { opaque: "cancel during final cleanup" };
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function () {
        controller.abort(reason);
        this.unref();
        return { status: "incomplete", reason: "injected cleanup denial" };
      },
    );
    try {
      const result = await probe(
        { ...connection, commands: ["ij"] },
        { ...options, signal: controller.signal },
      );
      assert.equal(
        projectAnalysisError(result.error).code,
        "cleanup_incomplete",
      );
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
      assert.equal(
        resolvedAnalysisError(result.error)._tag,
        "AnalysisCancelledError",
      );
      assert.equal(resolvedAnalysisError(result.error).cause, reason);
      assert.match(
        JSON.stringify(projectAnalysisError(result.error)),
        /completed-native-reply/u,
      );
    } finally {
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
    }
  }
});

test("a cancelled queued probe cannot admit a successor before the active owner finishes", async () => {
  const { connection, options, ready } = fixture("r2pipe", "blocked");
  const active = new AbortController();
  const pending = probe(
    { ...connection, commands: ["ij"] },
    { ...options, signal: active.signal },
  );
  const pid = await waitReady(ready);
  try {
    const reason = { opaque: "queued cancellation" };
    const cancelled = await probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: AbortSignal.abort(reason) },
    );
    assert.equal(cancelled.error.cause, reason);
    const next = fixture("exec", "completed");
    const successor = probe(
      { ...next.connection, commands: ["ij"] },
      next.options,
    );
    await delay(100);
    await assert.rejects(readFile(next.ready), { code: "ENOENT" });
    active.abort();
    await pending;
    assert.equal((await successor).ok, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    active.abort();
    await pending;
  }
});

for (const surface of ["probe", "analysis-server"]) {
  test(`${surface}: shutdown retains the live process owner until cleanup retry succeeds`, async () => {
    const { connection, options, ready } = fixture("r2pipe", "linger");
    const release = join(root, randomUUID());
    const stopped = join(root, randomUUID());
    const hook = join(root, randomUUID() + ".mjs");
    await writeFile(
      hook,
      `
      import { existsSync, writeFileSync } from "node:fs";
      import { ProviderProcessSupervisor } from ${JSON.stringify(new URL("../../dist/process/ProviderProcess.js", import.meta.url).href)};
      const stop = ProviderProcessSupervisor.prototype.stop;
      ProviderProcessSupervisor.prototype.stop = async function (...args) {
        if (!existsSync(${JSON.stringify(release)})) {
          writeFileSync(${JSON.stringify(stopped)}, String(process.pid));
          this.unref();
          return { status: "incomplete", reason: "injected cleanup denial until release" };
        }
        return stop.apply(this, args);
      };
    `,
    );
    const configuration = join(root, randomUUID() + ".json");
    await writeFile(configuration, JSON.stringify({ connection }));
    const launched = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [
        "--import",
        hook,
        fileURLToPath(new URL(`./${surface}.mjs`, import.meta.url)),
        surface === "probe"
          ? JSON.stringify({ ...connection, commands: ["ij"] })
          : configuration,
      ],
      runId: randomUUID(),
      hostEnvironment: options.environment,
      stdin: "pipe",
    });
    const owner = new ProviderProcessSupervisor(
      {
        ...launched,
        ownsProcessLifetime: true,
        cleanup:
          launched.cleanup ??
          (() => cleanupOwnedProcessGroup(launched.ownership)),
      },
      { maxDiagnosticBytes: 1024 * 1024 },
    );
    try {
      if (surface === "analysis-server") {
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "shutdown-regression", version: "0" },
            },
          }) + "\n",
        );
        for (let n = 0; !owner.snapshot().stdout.text.includes('"id":1'); n++) {
          assert.ok(n < 500, JSON.stringify(owner.snapshot()));
          await delay(10);
        }
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n",
        );
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "inspect_native_data_type",
              arguments: { type: "T" },
            },
          }) + "\n",
        );
      }
      const providerPid = await waitReady(ready, 2000);
      await waitReady(stopped, 2000);
      for (
        let n = 0;
        !owner.snapshot().stdout.text.includes("cleanup_incomplete");
        n++
      ) {
        assert.ok(n < 500, JSON.stringify(owner.snapshot()));
        await delay(10);
      }
      launched.process.stdin.end();
      if (surface === "probe") launched.process.kill("SIGTERM");
      await delay(1_200); // Cross an automatic retry with no open client input.
      assert.equal(launched.process.exitCode, null);
      assert.doesNotThrow(() => process.kill(providerPid, 0));
      await writeFile(release, "allow exact-owner cleanup");
      assert.equal(
        await owner.waitForExit(10_000),
        true,
        JSON.stringify(owner.snapshot()),
      );
      assert.throws(() => process.kill(providerPid, 0), { code: "ESRCH" });
      assert.match(owner.snapshot().stdout.text, /cleanup_incomplete/u);
    } finally {
      await writeFile(release, "allow cleanup even if an assertion failed");
      launched.process.stdin.end();
      await owner.waitForExit(10_000);
      assert.notEqual((await owner.stop()).status, "incomplete");
    }
  });
}

test("blocked pipe write cancels before releasing the analyst queue", async () => {
  const { connection, options, ready } = fixture("r2pipe", "blocked");
  const controller = new AbortController();
  const experiment = createAnalysisExperiment(connection, {
    ...options,
    prelude: ["x".repeat(2 * 1024 * 1024)],
  });
  const first = experiment.inspectType(
    { type: "T" },
    { signal: controller.signal },
  );
  const second = experiment.inspectType({ type: "invalid;command" });
  const pid = await waitReady(ready);
  await delay(100);
  controller.abort();
  assert.equal((await first).error._tag, "AnalysisCancelledError");
  assert.equal((await second).error._tag, "AnalysisInputError");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("blocked pipe write observes the batch deadline", async () => {
  const { connection, options } = fixture("r2pipe", "blocked");
  const began = performance.now();
  const result = await probe(
    { ...connection, commands: ["x".repeat(2 * 1024 * 1024)] },
    { ...options, timeoutMs: 1_000 },
  );
  cleaned(result);
  assert.ok(performance.now() - began < 5_000);
});

test("cancellation after provider cleanup retains completed replies and preserves earlier failures", async (context) => {
  for (const [mode, surface] of [
    ["completed", "probe"],
    ["invalid", "probe"],
    ["completed", "analysis"],
    ["invalid", "analysis"],
  ]) {
    const { connection, options } = fixture("r2pipe", mode);
    const controller = new AbortController();
    const reason = new Error("Caller cancelled after provider cleanup");
    const stop = ProviderProcessSupervisor.prototype.stop;
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function (...args) {
        const result = await stop.apply(this, args);
        controller.abort(reason);
        return result;
      },
    );
    try {
      const result =
        surface === "probe"
          ? await probe(
              { ...connection, commands: ["ij"] },
              { ...options, signal: controller.signal },
            )
          : await createAnalysisExperiment(connection, options).inspectType(
              { type: "T" },
              { signal: controller.signal },
            );
      cleaned(result);
      if (mode === "completed") {
        assert.equal(result.error._tag, "AnalysisCancelledError");
        assert.equal(result.error.cause, reason);
        assert.equal(result.error.partialObservation.cleanup, "complete");
        assert.equal(
          result.error.partialObservation.transcript.find(
            (entry) => entry.r2pipe2,
          ).r2pipe2.res,
          "completed-native-reply",
        );
      } else {
        assert.equal(result.error._tag, "AnalysisOutputError");
        assert.match(result.error.cause.message, /invalid UTF-8/u);
      }
    } finally {
      intercepted.mock.restore();
    }
  }
});

for (const mode of ["timeout", "missing"]) {
  test(`final hash ${mode} preserves completed replies and leaves verification unknown`, async () => {
    const { connection, options, ready } = fixture(
      "exec",
      `final-hash-${mode}`,
    );
    const path = join(root, randomUUID());
    const source = "selected target";
    await writeFile(path, source);
    const experiment = createAnalysisExperiment(
      { ...connection, path },
      {
        ...options,
        timeoutMs: mode === "timeout" ? 1_500 : 5_000,
        environment: { ...options.environment, REA_FAULT_TARGET: path },
      },
    );
    const result = await experiment.inspectType({ type: "T" });
    assert.equal(result.ok, false);
    assert.equal(
      result.error._tag,
      mode === "timeout" ? "AnalysisCancelledError" : "AnalysisOutputError",
    );
    if (mode === "timeout")
      assert.equal(result.error.cause.name, "TimeoutError");
    else assert.equal(result.error.cause.code, "ENOENT");
    // Exercise the same serializable error projection used by CLI and MCP.
    const projected = JSON.parse(
      JSON.stringify(projectAnalysisError(result.error)),
    );
    const partial = projected.details.partial_observation;
    assert.equal(partial.raw.cleanup, "complete");
    assert.equal(partial.replies[0].res, "completed-native-reply");
    assert.equal(partial.replies[0].command_outcome, "no_error_reported");
    assert.equal(partial.target.path, path);
    assert.equal(
      partial.target.sha256_before,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(partial.target.sha256_after, null);
    assert.match(
      JSON.stringify(partial.raw.transcript),
      /completed-native-stderr/u,
    );
    const pid = await waitReady(ready);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(
      (await experiment.inspectType({ type: "invalid;command" })).error._tag,
      "AnalysisInputError",
    );
  });
}

for (const transport of ["exec", "r2pipe", "r2mcp", "http"]) {
  test(`${transport}: invalid UTF-8 JSON cannot become normalized facts`, async () => {
    const { connection, options } = fixture(transport, "invalid");
    let server;
    let selected = connection;
    if (transport === "http") {
      server = createServer((_request, response) =>
        response.end(
          Buffer.concat([
            Buffer.from('{"error":false,"code":0,"res":"'),
            Buffer.from([255]),
            Buffer.from('"}'),
          ]),
        ),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      selected = {
        transport,
        endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      };
    }
    try {
      const result = await probe({ ...selected, commands: ["ij"] }, options);
      assert.equal(result.ok, false);
      assert.match(result.error.cause.message, /invalid UTF-8/u);
      assert.ok(
        result.error.partialObservation.transcript.every(
          (entry) => !entry.r2pipe2,
        ),
      );
      const raw = result.error.partialObservation.provider_partial.raw_reply;
      assert.equal(raw.invalid_utf8 ?? raw.invalidUtf8, true);
      if (transport !== "exec")
        assert.ok(Buffer.from(raw.base64, "base64").includes(255));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("ESIL observations preserve partial coverage in pages and complete replies when retention fills", async () => {
  const instructions = [
    {
      addr: 4096,
      size: 4,
      type: "cmov",
      esil: "zf,?{,1,x0,=,}{,2,x0,=,}",
    },
  ];
  const replies = new Map([
    ["aoj 1 @ 0x1000", instructions],
    ['\'aegf "zf,?{,1,x0,=,}{,2,x0,=,}" x0', "1,x0,=\n"],
  ]);
  const commands = [];
  const server = createServer(async (request, response) => {
    let source = "";
    for await (const part of request) source += part;
    const { cmd } = JSON.parse(source);
    commands.push(cmd);
    response.end(
      JSON.stringify({
        error: !replies.has(cmd),
        code: replies.has(cmd) ? 0 : 1,
        res: replies.get(cmd) ?? "Unmodeled command",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    transport: "http",
    endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
  };
  const input = {
    ir: "esil",
    address: "0x1000",
    instruction_count: 1,
    register: "x0",
  };
  try {
    const experiment = createAnalysisExperiment(connection);
    const observed = await experiment.trace(input);
    assert.equal(observed.ok, true);
    const { observation_id, result } = observed.value;
    const page = viewObservation(experiment, {
      observation_id,
      facet: "raw",
      offset: 0,
      limit: 100,
    });
    assert.equal(page.ok, true);
    assert.equal(page.value.coverage.status, "partial");
    assert.equal(page.value.coverage.coverage.instruction_count, 1);
    assert.deepEqual(page.value.coverage.coverage, result.coverage);
    assert.ok(page.value.coverage.coverage.partial_reasons.length);
    assert.deepEqual(
      page.value.coverage.target_consistency,
      result.target_consistency,
    );
    assert.equal(
      page.value.coverage.target_consistency.status,
      "unverified-external-core",
    );
    assert.equal(page.value.coverage.truncated, undefined);
    assert.equal(page.value.next_offset, 100);
    assert.equal(experiment.release(observation_id), true);
    assert.equal(experiment.view(observation_id).ok, false);

    const full = createAnalysisExperiment(connection, { maxRetainedBytes: 1 });
    const rejected = await full.trace(input);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error._tag, "AnalysisResourceConstraintError");
    assert.equal(rejected.error.reportedLimits.maximum_bytes, 1);
    const partial = JSON.parse(
      JSON.stringify(projectAnalysisError(rejected.error)),
    ).details.partial_observation;
    assert.deepEqual(partial.result.instructions, instructions);
    assert.equal(partial.result.reduced_expression, "1,x0,=\n");
    assert.ok(
      partial.result.command_outcomes.every(
        (outcome) => !Object.hasOwn(outcome, "value"),
      ),
    );
    assert.equal(
      partial.raw.instruction_observation.raw.cleanup,
      "external_session_unowned",
    );
    assert.equal(partial.raw.reduction_observation.replies[0].res, "1,x0,=\n");
    assert.deepEqual(commands, [...replies.keys(), ...replies.keys()]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
