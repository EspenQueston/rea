import { ownedProcessPrerequisiteFailure } from "../process/ProcessOwnershipObservation.js";
import type { ProviderAvailability } from "./AnalysisProvider.js";

/** A host prerequisite gap is the probed provider's unavailability, not a probe failure. */
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
