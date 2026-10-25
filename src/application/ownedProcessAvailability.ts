import { ownedProcessPrerequisiteFailure } from "../process/ProcessOwnershipObservation.js";
import type { ProviderAvailability } from "./AnalysisProvider.js";

/**
 * Project the shared owned-process prerequisite refusal as the probed
 * provider's unavailability. The host, not the provider, is missing a
 * prerequisite, so the probe answers instead of failing the discovery call
 * that aggregates every provider's status.
 */
export const ownedProcessPrerequisiteAvailability = (
  cause: unknown,
): ProviderAvailability | undefined => {
  const failure = ownedProcessPrerequisiteFailure(cause);
  if (failure === undefined) return undefined;
  return {
    status: "unavailable",
    code: "runtime_unavailable",
    reason:
      failure.remediationAction === undefined
        ? failure.reason
        : `${failure.reason}. ${failure.remediationAction}`,
    diagnostics: {
      stage: "ownership_preparation",
      prerequisite_provider_id: failure.providerId,
      prerequisite_operation: failure.operation,
    },
  };
};
