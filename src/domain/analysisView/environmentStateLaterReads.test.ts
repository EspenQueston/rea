import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  LATER_FIELD_ROWS,
  MAX_SIZE_ROWS,
  SOFT_DELETED_ROWS,
} from "../../../tests/fixtures/environmentStateLaterReads.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";
import { markedDeleted } from "./environmentStateRules.js";

const viewOf = (rows: readonly TimedCaptureRow[]) =>
  environmentStateViewOf(timedCaptureEvidence(rows));

const planOf = (rows: readonly TimedCaptureRow[], tool: string) => {
  const plan = viewOf(rows).writes.find((candidate) => candidate.tool === tool);
  if (plan === undefined) throw new Error(`No plan for ${tool}`);
  return plan;
};

describe("deletes the application answers for afterwards", () => {
  it("confirms a delete by an item read that shows the entity marked deleted", () => {
    expect(planOf(SOFT_DELETED_ROWS, "delete_contacts_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [5, 7],
    });
  });

  it.each([
    [{ deleted: true }, true],
    [{ isDeleted: true }, true],
    [{ is_deleted: true }, true],
    [{ deleted: false }, false],
    [{ deleted: "true" }, false],
    [{ deleted_at: "2026-10-26T10:00:00Z" }, false],
  ])("reads %j as soft-deleted: %s", (object, expected) => {
    expect(markedDeleted(object)).toBe(expected);
  });

  it("checks a list read whose page size is named `maxSize`", () => {
    expect(planOf(MAX_SIZE_ROWS, "delete_contacts_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [4, 6],
    });
  });
});

describe("fields only later reads show", () => {
  it("adds a field only created entities show to the item view, without requiring it", () => {
    const view = viewOf(LATER_FIELD_ROWS).views.find(
      (candidate) => candidate.tool === "get_tasks_by_id",
    );
    expect(view).toMatchObject({
      shape: "item",
      fields: ["id", "title", "done", "subscription"],
      required_fields: ["id", "title", "done"],
    });
  });

  it("serves an update whose answers show a field initial entities lack", () => {
    expect(planOf(LATER_FIELD_ROWS, "patch_tasks_by_id")).toMatchObject({
      served: true,
      checked_record_ordinals: [9, 11, 12],
    });
  });
});
