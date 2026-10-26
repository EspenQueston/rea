import { describe, expect, it } from "vitest";

import {
  LATER_FIELD_ROWS,
  SOFT_DELETED_ROWS,
} from "../../../tests/fixtures/environmentStateLaterReads.js";
import { servedFrom } from "../../../tests/fixtures/environmentStateServing.js";
import type { JsonValue } from "../../domain/jsonValue.js";

const names = (body: JsonValue | undefined): JsonValue[] => {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Expected an object body");
  const list = body["list"];
  if (!Array.isArray(list)) throw new Error("Expected a list");
  return list.map((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? (item["name"] ?? null)
      : null,
  );
};

describe("served writes modelled on later reads", () => {
  it("removes a soft-deleted contact from the served state", () => {
    const contacts = servedFrom(SOFT_DELETED_ROWS);
    contacts.answer("delete_contacts_by_id", { id: "1" });
    expect(names(contacts.answer("get_contacts").body)).toEqual([
      "Mina Okafor",
      "Rui Castellanos",
    ]);
  });

  it("answers an update of an initial entity without the field only created entities show", () => {
    const tasks = servedFrom(LATER_FIELD_ROWS);
    const body = tasks.answer("patch_tasks_by_id", {
      id: "1",
      body: { done: true },
    }).body;
    expect(body).toEqual({ id: 1, title: "Trim the wicks", done: true });
  });
});
