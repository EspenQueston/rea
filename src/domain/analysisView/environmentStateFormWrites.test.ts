import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  DERIVED_TEXT_ROWS,
  formLabelRows,
  ID_OR_TITLE_ROWS,
  LISTED_ID_ROWS,
  MINIMAL_CONTACT_ROWS,
  NOTE_DEFAULT_ROWS,
  RENAMED_LABEL_ROWS,
  TITLE_ORDER_ROWS,
  UNLOADED_ANSWER_ROWS,
} from "../../../tests/fixtures/environmentStateFormWrites.js";
import { environmentStateViewOf } from "../../../tests/fixtures/environmentStateWrites.js";
import { mergedCreatePlan } from "./environmentStateWriteCreateCalls.js";
import { resortedMembers } from "./environmentStateWriteExplain.js";
import type { WriteBody } from "./environmentStateWriteRules.js";

const planOf = (rows: readonly TimedCaptureRow[], tool: string) => {
  const plan = environmentStateViewOf(timedCaptureEvidence(rows)).writes.find(
    (candidate) => candidate.tool === tool,
  );
  if (plan === undefined) throw new Error(`No plan for ${tool}`);
  return plan;
};

const BY_NAME = { rule: "sorted", field: "name", direction: "ascending" };

describe("create members a form sent empty", () => {
  it("requires only the members some recorded create filled in, and applies the others as they were sent", () => {
    expect(planOf(formLabelRows(), "post_labels")).toMatchObject({
      served: true,
      body: {
        accepted: ["name", "description", "color", "icon"],
        required: ["name"],
        blank: [
          { member: "color", sent: "" },
          { member: "icon", sent: "" },
          { member: "description", sent: "" },
        ],
      },
    });
  });

  it("accepts either spelling of a member two creates sent empty differently, filling the earliest", () => {
    const body: WriteBody = {
      accepted: ["name", "note"],
      fixed: [],
      required: ["name"],
      identity: null,
      kinds: [],
      blank: [{ member: "note", sent: "" }],
    };
    const rules = [
      { field: "id", rule: "identity", generator: "sequence" },
      { field: "name", rule: "echo" },
      { field: "note", rule: "echo" },
    ] as const;
    const merged = mergedCreatePlan(
      { rules: [...rules], body },
      { id: 1, name: "One", note: "" },
      {
        entity: { id: 2, name: "Two", note: null },
        body: { name: "Two", note: null },
        rules: [...rules],
        contract: { ...body, blank: [{ member: "note", sent: null }] },
      },
    );
    expect(merged?.body).toMatchObject({
      required: ["name"],
      blank: [
        { member: "note", sent: "" },
        { member: "note", sent: null },
      ],
    });
  });
});

describe("empty values and defaults", () => {
  it("keeps accepting a recorded empty value after a later call that left the member out teaches its default", () => {
    expect(planOf(NOTE_DEFAULT_ROWS, "post_notes")).toMatchObject({
      served: true,
      body: {
        required: ["name"],
        defaults: [{ member: "note", value: "" }],
        blank: [{ member: "note", sent: null }],
      },
    });
  });
});

describe("a create with only what a person must give", () => {
  it("serves a create whose minimal call left string members `null` and an empty flag spelled another way", () => {
    expect(planOf(MINIMAL_CONTACT_ROWS, "post_contacts")).toMatchObject({
      served: true,
      body: {
        required: ["lastName"],
        blank: expect.arrayContaining([
          { member: "firstName", sent: null },
          { member: "email", sent: null },
          { member: "emailOptedOut", sent: false },
          { member: "emailOptedOut", sent: null },
        ]),
      },
    });
  });
});

describe("collections kept sorted", () => {
  it("moves an updated entity by the field its collection's creates insert by", () => {
    expect(planOf(RENAMED_LABEL_ROWS, "patch_labels_by_id")).toMatchObject({
      served: true,
      insert: BY_NAME,
    });
  });

  it("learns the sort from a rename that moves a folder, and inserts creates by it", () => {
    const byTitle = { rule: "sorted", field: "title", direction: "ascending" };
    expect(planOf(TITLE_ORDER_ROWS, "put_folders_by_id")).toMatchObject({
      served: true,
      insert: byTitle,
    });
    expect(planOf(TITLE_ORDER_ROWS, "post_folders")).toMatchObject({
      served: true,
      insert: byTitle,
    });
  });

  it("learns the title order from a rename when the creates fit both id and title order", () => {
    const byTitle = { rule: "sorted", field: "title", direction: "ascending" };
    expect(planOf(ID_OR_TITLE_ROWS, "put_folders_by_id")).toMatchObject({
      served: true,
      insert: byTitle,
    });
    expect(planOf(ID_OR_TITLE_ROWS, "post_folders")).toMatchObject({
      insert: byTitle,
    });
  });

  it("moves each written entity in turn, against the others' values before their own writes", () => {
    const entity = (id: string, name: string) => ({ id, fields: { name } });
    const [a, b, c, d] = ["a", "b", "c", "d"].map((name, index) =>
      entity(String(index + 1), name),
    ) as [ReturnType<typeof entity>, ...ReturnType<typeof entity>[]];
    const order = resortedMembers(
      { rule: "sorted", field: "name", direction: "ascending" },
      [a, b!, c!, d!],
      [
        { before: b!, after: entity("2", "h") },
        { before: c!, after: entity("3", "i") },
      ],
    );
    expect(order.map(({ fields }) => fields["name"])).toEqual([
      "a",
      "d",
      "h",
      "i",
    ]);
  });

  it("renders a list envelope's ids of the listed entities from the state", () => {
    const view = environmentStateViewOf(
      timedCaptureEvidence(LISTED_ID_ROWS),
    ).views.find((candidate) => candidate.tool === "get_tags");
    expect(view).toMatchObject({
      shape: "list",
      listed_ids: [{ member: "all", field: "id" }],
    });
    expect(planOf(LISTED_ID_ROWS, "post_tags")).toMatchObject({
      served: true,
      insert: BY_NAME,
    });
  });
});

describe("answers that show stored values otherwise than reads", () => {
  it("takes the later read's values where a create's answer had not loaded them", () => {
    expect(planOf(UNLOADED_ANSWER_ROWS, "post_tasks")).toMatchObject({
      served: true,
      observation: { read: { shape: "item" } },
    });
  });

  it("reads an empty list spelled `[]` in an update's answer and `null` in reads as unchanged", () => {
    expect(planOf(UNLOADED_ANSWER_ROWS, "patch_tasks_by_id")).toMatchObject({
      served: true,
      rules: [{ field: "done", rule: "echo" }],
    });
  });

  it("withholds a later create that stored an unruled field otherwise, without blocking checks of later writes", () => {
    expect(planOf(DERIVED_TEXT_ROWS, "post_tags")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
    expect(planOf(DERIVED_TEXT_ROWS, "delete_tags_by_id")).toMatchObject({
      served: true,
    });
  });
});
