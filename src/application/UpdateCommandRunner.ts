import spawn from "cross-spawn";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  ProviderProcessSupervisor,
  type ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import { err, ok, type Result } from "../domain/result.js";
import { UpdateCommandProgress } from "./UpdateCommandProgress.js";
import type { UpdateOutput } from "./Update.js";
import { withoutPackageRunnerIdentity } from "./ClientRegistrationIdentity.js";

/** Aggregate raw-byte retention policy for package-manager replies and diagnostics. */
export const UPDATE_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Grace period before an uncooperative update subprocess is terminated and escalated to SIGKILL. */
export const DEFAULT_UPDATE_TERMINATION_GRACE_MS = 1_000;
const UPDATE_PROBE_TIMEOUT_MS = 10_000;

/** Output collection limits applied to update subprocesses. */
export interface UpdateCommandLimits {
  /** Shared stdout and stderr retention budget. Defaults to `UPDATE_COMMAND_OUTPUT_BYTES`. */
  readonly maxOutputBytes?: number;
  /**
   * Time an oversized complete-output writer gets to exit on its own before it is
   * sent `SIGTERM`, and again before `SIGKILL`. Defaults to `DEFAULT_UPDATE_TERMINATION_GRACE_MS`.
   */
  readonly terminationGraceMs?: number;
}

interface ResolvedUpdateCommandLimits {
  readonly maxOutputBytes: number;
  readonly terminationGraceMs: number;
}

/** Own metadata subprocesses through cancellation, final collection and cleanup retry. */
export class UpdateCommandRunner {
  readonly #resources = new ArtifactResourceScope();
  readonly #controller = new AbortController();
  readonly #limits: ResolvedUpdateCommandLimits;
  constructor(
    private readonly probeTimeoutMs = UPDATE_PROBE_TIMEOUT_MS,
    limits: UpdateCommandLimits = {},
  ) {
    this.#limits = {
      maxOutputBytes: limits.maxOutputBytes ?? UPDATE_COMMAND_OUTPUT_BYTES,
      terminationGraceMs:
        limits.terminationGraceMs ?? DEFAULT_UPDATE_TERMINATION_GRACE_MS,
    };
  }

  async runProbe(
    command: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    output: UpdateOutput = "structured",
    workingDirectory?: string,
  ): Promise<Result<string, string>> {
    if (this.#controller.signal.aborted)
      return err("Update command runner is closed.");
    const deadline = new ProviderStartupDeadline(
      this.probeTimeoutMs,
      this.#controller.signal,
    );
    try {
      return await this.#resources.run(() =>
        runUpdateProcess(
          command,
          environment,
          output,
          workingDirectory,
          "complete",
          this.#resources,
          this.#limits,
          deadline,
        ),
      );
    } catch (cause: unknown) {
      return err(cause instanceof Error ? cause.message : String(cause));
    } finally {
      deadline.dispose();
    }
  }

  async runInstall(
    command: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    output: UpdateOutput,
    workingDirectory?: string,
  ): Promise<Result<string, string>> {
    if (this.#controller.signal.aborted)
      return err("Update command runner is closed.");
    return this.#resources
      .run(() =>
        runUpdateProcess(
          command,
          environment,
          output,
          workingDirectory,
          "diagnostics",
          this.#resources,
          this.#limits,
        ),
      )
      .catch((cause: unknown) =>
        err(cause instanceof Error ? cause.message : String(cause)),
      );
  }

  close(): Promise<void> {
    this.#controller.abort(new Error("Update command runner closed."));
    return this.#resources.close();
  }
}

const runUpdateProcess = async (
  command: readonly string[],
  selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
  output: UpdateOutput,
  workingDirectory: string | undefined,
  retention: "complete" | "diagnostics",
  resources: ArtifactResourceScope,
  limits: ResolvedUpdateCommandLimits,
  probe?: ProviderStartupDeadline,
): Promise<Result<string, string>> => {
  if (probe?.signal.aborted)
    return err("Update metadata probe cancelled before launch.");
  const [executable, ...args] = command;
  if (executable === undefined) return err("No executable supplied.");
  const environment = withoutPackageRunnerIdentity(selectedEnvironment);
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
    windowsHide: true,
    ...(workingDirectory === undefined ? {} : { cwd: workingDirectory }),
  });
  let processFailure: string | undefined;
  let outputBudgetExceeded = false;
  const { terminationGraceMs } = limits;
  let drainGraceTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const running = (): boolean =>
    child.exitCode === null && child.signalCode === null;
  const clearTimers = (): void => {
    if (drainGraceTimer !== undefined) clearTimeout(drainGraceTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    drainGraceTimer = undefined;
    killTimer = undefined;
  };
  const onExit = (): void => {
    clearTimers();
  };
  const signal = (name: NodeJS.Signals): void => {
    try {
      child.kill(name);
    } catch {
      // Subprocess may have already terminated.
    }
  };
  const terminate = (): void => {
    if (!running()) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
    signal("SIGTERM");
    if (!running()) return;
    if (terminationGraceMs <= 0) {
      signal("SIGKILL");
      return;
    }
    killTimer = setTimeout(() => {
      killTimer = undefined;
      if (running()) signal("SIGKILL");
    }, terminationGraceMs);
    killTimer.unref();
  };
  // A rejected complete reply is never accepted, so an endless writer must not hold the
  // probe open until its deadline. A finite writer still gets the grace window to exit.
  const scheduleTerminationAfterDrainGrace = (): void => {
    if (drainGraceTimer !== undefined || killTimer !== undefined || !running())
      return;
    if (terminationGraceMs <= 0) {
      terminate();
      return;
    }
    drainGraceTimer = setTimeout(() => {
      drainGraceTimer = undefined;
      terminate();
    }, terminationGraceMs);
    drainGraceTimer.unref();
  };
  child.once("exit", onExit);
  const supervisor = new ProviderProcessSupervisor(
    { process: child, ownsProcessLifetime: true },
    {
      maxDiagnosticBytes: limits.maxOutputBytes,
      onDiagnostic: (event) => {
        if (event.type === "error") processFailure ??= event.message;
        if (event.type === "output" && event.truncated === true) {
          // `snapshot().diagnosticTruncated` also reports incomplete output, so record
          // the byte-budget overflow itself, and only when no failure preceded it.
          if (processFailure === undefined) outputBudgetExceeded = true;
          if (retention === "complete") scheduleTerminationAfterDrainGrace();
        }
      },
    },
  );
  const progress =
    output === "human" ? new UpdateCommandProgress(process.stderr) : undefined;
  if (progress !== undefined) {
    for (const stream of [child.stdout, child.stderr])
      if (stream !== null) progress.pipe(stream);
  }
  let retained = false;
  try {
    // Drain even an oversized reply. Verbosity must not interrupt a package install.
    // Keep the existing launch/signal policy; this collector owns no process-tree authority.
    const completed = await supervisor.waitForOutputClose(
      undefined,
      probe?.signal,
    );
    let interrupted: string | undefined;
    if (!completed) {
      interrupted =
        probe?.interruption === "timeout"
          ? `Update metadata probe timed out after ${String(probe.timeoutMs)} ms.`
          : "Update metadata probe cancelled.";
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete") {
        retained = true;
        resources.retain({
          kind: "lease",
          resource: executable,
          lease: {
            release: async () => {
              const retried = await supervisor.stop();
              if (retried.status === "incomplete")
                throw new Error(retried.reason);
            },
          },
        });
        interrupted += ` Cleanup incomplete: ${stopped.reason}`;
      }
    }
    const progressFailure = await progress?.close();
    const snapshot = supervisor.snapshot();
    // An overflow can destroy streams and terminate the child after the drain grace window,
    // so the complete-output budget error takes precedence over the resulting teardown
    // stream or process errors. A failure observed before any overflow keeps its own
    // cause, and probe interruption keeps its own cleanup report.
    if (
      interrupted === undefined &&
      retention === "complete" &&
      outputBudgetExceeded
    )
      return err(
        `Update command output exceeded the ${String(limits.maxOutputBytes)}-byte complete-output retention budget; reply was not accepted.`,
      );
    if (processFailure !== undefined)
      return err(
        probeFailureDetail(
          interrupted === undefined
            ? processFailure
            : `${processFailure} ${interrupted}`,
          snapshot,
        ),
      );
    if (interrupted !== undefined)
      return err(probeFailureDetail(interrupted, snapshot));
    if (snapshot.outputIncomplete === true)
      return err("Update command output did not close completely.");
    if (snapshot.exitCode !== 0 || snapshot.signal !== null) {
      const detail =
        snapshot.stderr.text.trim() ||
        snapshot.stdout.text.trim() ||
        (typeof snapshot.signal === "string"
          ? `Process terminated by ${snapshot.signal}.`
          : typeof snapshot.exitCode === "number"
            ? `Process exited with code ${snapshot.exitCode}.`
            : "Update command failed without a recorded exit status.");
      return err(
        snapshot.diagnosticTruncated
          ? `${detail}\n[Update diagnostics truncated at ${String(limits.maxOutputBytes)} bytes; later output omitted.]`
          : detail,
      );
    }
    if (
      retention === "complete" &&
      (snapshot.stdout.invalidUtf8 || snapshot.stderr.invalidUtf8)
    )
      return err(
        "Update command returned invalid UTF-8; complete output is unavailable.",
      );
    if (progressFailure !== undefined)
      return err(`Update progress output failed: ${progressFailure.message}`);
    if (probe?.interruption !== undefined)
      return err(
        probeFailureDetail(
          probe.interruption === "timeout"
            ? `Update metadata probe timed out after ${String(probe.timeoutMs)} ms.`
            : "Update metadata probe cancelled.",
          snapshot,
        ),
      );
    return ok(retention === "diagnostics" ? "" : snapshot.stdout.text.trim());
  } finally {
    clearTimers();
    child.removeListener("exit", onExit);
    // Failed stop ownership stays on the runner for a later cleanup attempt.
    if (!retained) supervisor.dispose();
    await progress?.close();
  }
};

const probeFailureDetail = (
  reason: string,
  snapshot: ProviderProcessSnapshot,
): string =>
  [
    reason,
    snapshot.stdout.text === "" ? "" : `stdout: ${snapshot.stdout.text}`,
    snapshot.stderr.text === "" ? "" : `stderr: ${snapshot.stderr.text}`,
    snapshot.diagnosticTruncated ? "[Update diagnostics truncated.]" : "",
    snapshot.outputIncomplete
      ? "[Update output did not close completely.]"
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
