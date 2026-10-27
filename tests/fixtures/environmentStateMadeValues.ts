import type { JsonObject } from "../../src/domain/analysisView/environmentStateRules.js";
import type { TimedCaptureRow } from "./analysisView.js";
import { bookClock } from "./environmentStateWrites.js";

const seed = (id: number, index: number): JsonObject => ({
  id,
  title: `Seeded task ${String(id)}`,
  project_id: 5,
  index,
  identifier: `#${String(index)}`,
  subscription: null,
  created: "2026-10-01T09:00:00Z",
});

const SEEDS = [seed(1, 1), seed(2, 2)];

/** A task the application made at row `row`: numbered past tasks deleted before the capture, its subscription not loaded yet. */
const made = (
  id: number,
  index: number,
  title: string,
  row: number,
): JsonObject => ({
  id,
  title,
  project_id: 5,
  index,
  identifier: `#${String(index)}`,
  subscription: null,
  created: bookClock(row),
});

/** The task as a later read shows it, with the subscription the application made for its creator. */
const subscribed = (
  task: JsonObject,
  subscription: number,
  row: number,
): JsonObject => ({
  ...task,
  subscription: {
    id: subscription,
    entity: "task",
    entity_id: task["id"]!,
    created: bookClock(row),
  },
});

const FIRST = made(20, 15, "Replace the lens gasket", 2);
const SECOND = made(21, 16, "Log the fog-signal tests", 5);

/** Two task creates at a project path, each read back with a made subscription, then the list. */
export const COUNTED_TASK_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/tasks", SEEDS],
  ["GET", "/api/tasks/1", SEEDS[0]!],
  ["POST", "/api/projects/5/tasks", FIRST, 201, { title: FIRST["title"]! }],
  ["GET", "/api/tasks/20", subscribed(FIRST, 21, 2)],
  ["GET", "/api/tasks", [...SEEDS, subscribed(FIRST, 21, 2)]],
  ["POST", "/api/projects/5/tasks", SECOND, 201, { title: SECOND["title"]! }],
  ["GET", "/api/tasks/21", subscribed(SECOND, 22, 5)],
  [
    "GET",
    "/api/tasks",
    [...SEEDS, subscribed(FIRST, 21, 2), subscribed(SECOND, 22, 5)],
  ],
];

/** As COUNTED_TASK_ROWS, through a bulk path whose body and answer wrap the one task in `tasks`. */
export const BULK_TASK_ROWS: readonly TimedCaptureRow[] = COUNTED_TASK_ROWS.map(
  (row) =>
    row[0] === "POST"
      ? [
          "POST",
          `${row[1]}/bulk`,
          { tasks: [row[2]!] },
          201,
          { tasks: [row[4]!] },
        ]
      : row,
);

/** COUNTED_TASK_ROWS up to the first create's reads: one create alone shows no counter. */
export const ONE_TASK_ROWS: readonly TimedCaptureRow[] =
  COUNTED_TASK_ROWS.slice(0, 5);
