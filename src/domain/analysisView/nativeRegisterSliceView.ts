import { z } from "zod";
import { nativeRegisterSliceSchema } from "../native/nativeRegisterSlice.js";
import { jsonValueSchema } from "../jsonValue.js";
import { ok } from "../result.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { err } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import type { Result } from "../result.js";
import type { AnalysisError } from "../analysisErrorBase.js";

export const nativeRegisterSliceViewRequestSchema = z.strictObject({
  kind: z.literal("native-register-slice"),
  collection: z.enum(["nodes", "edges", "control_flow"]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(1000).default(64),
});
export const nativeRegisterSliceSummarySchema = nativeRegisterSliceSchema
  .omit({ nodes: true, edges: true, control_flow: true })
  .extend({
    node_count: z.int().nonnegative(),
    edge_count: z.int().nonnegative(),
    control_edge_count: z.int().nonnegative(),
  });
const read = createAnalysisViewResultReader(nativeRegisterSliceSchema);
export const projectNativeRegisterSliceView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "native-register-slice")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Register slices support summary and native-register-slice pages",
        },
      ]),
    );
  const parsed = read(parent);
  if (!parsed.ok) return parsed;
  const { nodes, edges, control_flow, ...summary } = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "slice_native_register" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    source_provider: parent.provider ?? null,
    source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
    source_parameters: jsonValueSchema.parse(parent.parameters ?? null),
    limitations: [...parent.limitations, ...summary.limitations],
    unknowns: summary.unresolved
      ? ["See retained graph unknown nodes and load dependencies"]
      : [],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary",
      view,
      summary: {
        ...summary,
        node_count: nodes.length,
        edge_count: edges.length,
        control_edge_count: control_flow.length,
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  const collection = { nodes, edges, control_flow }[view.collection];
  const items = collection.slice(view.offset, view.offset + view.limit);
  return ok({
    ...shared,
    kind: "native-register-slice",
    view,
    items: jsonValueSchema.array().parse(items),
    coverage: pageViewCoverage(view.offset, items.length, collection.length),
  });
};
