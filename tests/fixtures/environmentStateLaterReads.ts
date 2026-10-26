import type { JsonValue } from "../../src/domain/jsonValue.js";
import type { TimedCaptureRow } from "./analysisView.js";

type Entity = Record<string, JsonValue>;

const contact = (id: number, name: string): Entity => ({
  id,
  name,
  deleted: false,
});

const page = (list: readonly Entity[]): Entity => ({
  total: list.length,
  list: [...list],
});

const ADA = contact(1, "Ada Finch");
const MINA = contact(2, "Mina Okafor");
const RUI = contact(3, "Rui Castellanos");

/** A contact deleted, then read by id as EspoCRM answers for soft-deleted records: still found, marked `deleted`. */
export const SOFT_DELETED_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/contacts?maxSize=20&offset=0", page([ADA, MINA, RUI])],
  ["GET", "/api/contacts/1", ADA],
  ["GET", "/api/contacts/2", MINA],
  ["GET", "/api/contacts/3", RUI],
  ["DELETE", "/api/contacts/2", true],
  ["GET", "/api/contacts/2", { ...MINA, deleted: true }],
  ["DELETE", "/api/contacts/3", true],
  ["GET", "/api/contacts/3", { ...RUI, deleted: true }],
];

/** Contacts deleted, then listed with a page size named `maxSize` other than the initial list's. */
export const MAX_SIZE_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/contacts?maxSize=20&offset=0", page([ADA, MINA, RUI])],
  ["GET", "/api/contacts?maxSize=2&offset=0", page([ADA, MINA])],
  ["GET", "/api/contacts/1", ADA],
  ["DELETE", "/api/contacts/2", true],
  ["GET", "/api/contacts?maxSize=50&offset=0", page([ADA, RUI])],
  ["DELETE", "/api/contacts/3", true],
  ["GET", "/api/contacts?maxSize=50&offset=0", page([ADA])],
];

const task = (id: number, title: string, extra: Entity = {}): Entity => ({
  id,
  title,
  done: false,
  ...extra,
});

/** Its subscription: shown only on tasks created while recording, as Vikunja subscribes their creator. */
const subscribed = (id: number): Entity => ({
  subscription: { id: 100 + id, entity: "task", entity_id: id },
});

/**
 * Seeded tasks without a `subscription`, created tasks whose item reads show one, and updates of the created tasks,
 * whose answers show it too.
 */
export const LATER_FIELD_ROWS: readonly TimedCaptureRow[] = (() => {
  const seed = task(1, "Trim the wicks");
  const first = task(2, "Order lamp oil");
  const second = task(3, "Paint the rail");
  const created = (entity: Entity) => ({
    ...entity,
    ...subscribed(Number(entity["id"])),
  });
  const done = (entity: Entity) => ({ ...created(entity), done: true });
  return [
    ["GET", "/api/tasks", [seed]],
    ["GET", "/api/tasks/1", seed],
    ["POST", "/api/tasks", first, 201, { title: "Order lamp oil" }],
    ["GET", "/api/tasks/2", created(first)],
    ["GET", "/api/tasks", [seed, first]],
    ["POST", "/api/tasks", second, 201, { title: "Paint the rail" }],
    ["GET", "/api/tasks/3", created(second)],
    ["GET", "/api/tasks", [seed, first, second]],
    ["PATCH", "/api/tasks/2", done(first), 200, { done: true }],
    ["GET", "/api/tasks/2", done(first)],
    ["PATCH", "/api/tasks/3", done(second), 200, { done: true }],
    ["GET", "/api/tasks/3", done(second)],
    [
      "GET",
      "/api/tasks",
      [seed, { ...first, done: true }, { ...second, done: true }],
    ],
  ];
})();
