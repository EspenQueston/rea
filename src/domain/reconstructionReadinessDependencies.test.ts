import { describe, expect, it } from "vitest";
import { RECONSTRUCTION_READINESS_EXAMPLE } from "../contracts/reconstructionReadinessExample.js";
import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  reconstructionObligationDependencyGraph,
  reconstructionObligationLedgerClosureDigest,
  reconstructionObligationOwnershipGraph,
  reconstructionObligationReports,
  summarizeReconstructionObligations,
} from "./reconstructionObligationLedgerIntegrity.js";
import { reconstructionObligationLedgerSchema } from "./reconstructionObligationLedgerSchemas.js";
import { createReconstructionReadinessReport } from "./reconstructionReadiness.js";

type Node = {
  id: string;
  dependencies: string[];
  required?: boolean;
  identicalControl?: boolean;
  open?: boolean;
};

// Construct an authenticated historical snapshot, not a newly evaluated ledger.
const historical = (nodes: Node[], validateLedger = true) => {
  const input = structuredClone(RECONSTRUCTION_READINESS_EXAMPLE);
  const template = input.obligation_ledger.obligations[0]!;
  const records = [...input.evidence_bundle.records];
  const obligations = nodes.map((node) => {
    const obligation = structuredClone(template);
    obligation.obligation_id = node.id;
    obligation.required = node.required ?? false;
    obligation.dependency_obligation_ids = node.dependencies;
    obligation.status = node.open ? "implemented" : "verified";
    const binding = obligation.binding!;
    binding.obligation_id = node.id;
    binding.owner.module_path = `src/${node.id}.ts`;
    const verifier = binding.verifier!;
    verifier.enumerated_obligation_ids = [node.id];
    const control = verifier.negative_controls![0]!;
    for (const side of ["positive", "control"] as const) {
      const id =
        side === "positive"
          ? verifier.result_evidence_id
          : control.result_evidence_id;
      const source = input.evidence_bundle.records.find(
        (record) => record.evidence_id === id,
      )!;
      const result = source.normalized_result;
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result)
      )
        throw new Error("Expected proof");
      const proof = createEvidence(undefined, source.provider, {
        predicateType: source.predicate_type,
        operation: source.operation,
        parameters: source.parameters,
        confidence: source.confidence,
        authority: source.authority,
        result: {
          ...result,
          obligation_ids: [node.id],
          ...(side === "control" && node.identicalControl
            ? {
                fixture_sha256s: {
                  "fixture.deliberate-defect": "a".repeat(64),
                },
              }
            : {}),
        },
      });
      records.push(proof);
      if (side === "positive") verifier.result_evidence_id = proof.evidence_id;
      else control.result_evidence_id = proof.evidence_id;
    }
    return obligation;
  });
  input.evidence_bundle = createEvidenceBundle([
    ...new Map(records.map((record) => [record.evidence_id, record])).values(),
  ]);
  const ledger = input.obligation_ledger;
  ledger.obligations = obligations;
  ledger.summary = summarizeReconstructionObligations(obligations);
  ledger.reports = reconstructionObligationReports(obligations);
  ledger.ownership_graph = reconstructionObligationOwnershipGraph(obligations);
  ledger.dependency_graph =
    reconstructionObligationDependencyGraph(obligations);
  ledger.evidence_links = input.evidence_bundle.records
    .map((record) => record.evidence_id)
    .sort();
  ledger.closure_digest = reconstructionObligationLedgerClosureDigest(ledger);
  input.closure_history.at(-1)!.ledger_digest = ledger.closure_digest;
  input.closure_history.at(-1)!.newly_verified_obligation_ids = nodes
    .filter((node) => node.required)
    .map((node) => node.id);
  if (validateLedger)
    expect(reconstructionObligationLedgerSchema.parse(ledger)).toEqual(ledger);
  return input;
};

describe("historical readiness dependency proof", () => {
  it.each([
    [
      "required",
      [
        {
          id: "root",
          required: true,
          dependencies: [],
          identicalControl: true,
        },
        { id: "root", dependencies: [] },
      ],
    ],
    [
      "dependency",
      [
        { id: "root", required: true, dependencies: ["dependency"] },
        { id: "dependency", dependencies: [], identicalControl: true },
        { id: "dependency", dependencies: [] },
      ],
    ],
  ] satisfies [string, Node[]][])(
    "rejects duplicate %s IDs before readiness assessment",
    (_case, nodes) => {
      const input = historical(nodes, false);
      expect(() => createReconstructionReadinessReport(input)).toThrow(
        /Obligation IDs must be unique/u,
      );
    },
  );

  it.each([
    [
      "direct",
      [
        { id: "root", required: true, dependencies: ["bad"] },
        { id: "bad", dependencies: [], identicalControl: true },
      ],
    ],
    [
      "indirect",
      [
        { id: "root", required: true, dependencies: ["middle"] },
        { id: "middle", dependencies: ["bad"] },
        { id: "bad", dependencies: [], identicalControl: true },
      ],
    ],
    [
      "cyclic",
      [
        { id: "root", required: true, dependencies: ["bad"] },
        { id: "bad", dependencies: ["root"], identicalControl: true },
      ],
    ],
    [
      "shared",
      [
        { id: "root", required: true, dependencies: ["middle", "bad"] },
        { id: "middle", dependencies: ["bad"] },
        { id: "bad", dependencies: [], identicalControl: true },
      ],
    ],
  ] satisfies [string, Node[]][])(
    "reassesses %s optional dependencies without changing history",
    (_label, nodes) => {
      const input = historical(nodes);
      const before = JSON.stringify(input.obligation_ledger);
      const report = createReconstructionReadinessReport(input);
      expect(report.status).toBe("unknown");
      expect(
        report.findings.filter(
          (finding) =>
            finding.code === "reconstruction-invalid-control-candidate",
        ),
      ).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining("bad:"),
          status: "unknown",
        }),
      ]);
      expect(JSON.stringify(input.obligation_ledger)).toBe(before);
    },
  );

  it("accepts valid dependency proof while ignoring unrelated optional invalid controls", () => {
    const input = historical([
      { id: "root", required: true, dependencies: ["middle"] },
      { id: "middle", dependencies: ["leaf"] },
      { id: "leaf", dependencies: [] },
      { id: "unrelated", dependencies: [], identicalControl: true },
    ]);
    expect(createReconstructionReadinessReport(input)).toMatchObject({
      status: "pass",
      findings: [],
    });
  });

  it.each(["missing", "open"])(
    "does not trust a ready snapshot with a %s dependency",
    (kind) => {
      const input = historical([
        { id: "root", required: true, dependencies: ["dependency"] },
        ...(kind === "open"
          ? [{ id: "dependency", dependencies: [], open: true }]
          : []),
      ]);
      const report = createReconstructionReadinessReport(input);
      expect(report.status).toBe("unknown");
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: `reconstruction-dependency-${kind}` }),
      );
    },
  );
});
