import { parseAnalysisInput } from "./AnalysisInput.js";
import type {
  AnalysisOperationPort,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import { nativeProcedureInputSchema } from "../domain/native/nativeProcedureInput.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createAnalysisExecutionEvidence } from "../domain/analysisObservation.js";
import { parseFunctionDossier } from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { completeProviderEvidence } from "./ProviderOperationExecution.js";

/**
 * Preserve the provider's observations when presenting a validated function
 * dossier. Parameters are the provider input only: adapters separate delivery
 * options such as MCP detail before calling.
 */
export const executeFunctionAnalysisEvidence = async (
  analysis: AnalysisOperationPort,
  parameters: Readonly<Record<string, JsonValue>>,
  target: BinaryTarget | undefined,
  options?: ExecutionOptions,
) => {
  const input = parseAnalysisInput(
    "analyze_function",
    parameters,
    nativeProcedureInputSchema,
    options?.signal,
  );
  if (!input.ok) return input;
  const arguments_ = input.value;
  const execution = await analysis.execute(
    "analyze_function",
    arguments_,
    options,
  );
  if (!execution.ok) return execution;
  const dossier = parseFunctionDossier(execution.value.result);
  if (!dossier.ok) return dossier;
  const observation = execution.value;
  return completeProviderEvidence(
    createAnalysisExecutionEvidence(
      "analyze_function",
      arguments_,
      {
        ...observation,
        result: dossier.value,
        ...(observation.subject === undefined && target !== undefined
          ? { subject: target }
          : {}),
      },
      "observed",
    ),
    options?.signal,
  );
};
