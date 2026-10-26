import type { JsonValue } from "../../src/domain/jsonValue.js";
import type { TimedCaptureRow } from "./analysisView.js";
import { bookClock } from "./environmentStateWrites.js";

type Entity = Record<string, JsonValue>;

const label = (
  id: number,
  name: string,
  fields: { readonly description?: string; readonly color?: string } = {},
): Entity => ({
  id,
  name,
  description: fields.description ?? "",
  color: fields.color ?? "",
  icon: "",
});

const KITCHEN = label(1, "Kitchen", { description: "Pots", color: "#aa3300" });
const TOOLS = label(2, "Tools");

/** What a label form sends: every member, those left as they were empty. */
const formBody = (entity: Entity): Entity => {
  const { id: _id, ...sent } = entity;
  return sent;
};

/** Two label creates through a form that sends every member, the members left empty differing between them, in a collection kept sorted by name. */
export const formLabelRows = (
  icons: readonly [JsonValue, JsonValue] = ["", ""],
): TimedCaptureRow[] => {
  const garden = label(3, "Garden", { description: "Seeds" });
  const attic = label(4, "Attic", { color: "#00aa44" });
  return [
    ["GET", "/api/labels", [KITCHEN, TOOLS]],
    ["GET", "/api/labels/1", KITCHEN],
    ["GET", "/api/labels/2", TOOLS],
    [
      "POST",
      "/api/labels",
      garden,
      201,
      { ...formBody(garden), icon: icons[0] },
    ],
    ["GET", "/api/labels/3", garden],
    ["GET", "/api/labels", [garden, KITCHEN, TOOLS]],
    ["POST", "/api/labels", attic, 201, { ...formBody(attic), icon: icons[1] }],
    ["GET", "/api/labels/4", attic],
    ["GET", "/api/labels", [attic, garden, KITCHEN, TOOLS]],
  ];
};

/** The form label creates, then a rename that moves a label to the end of the name order, read back. */
export const RENAMED_LABEL_ROWS: readonly TimedCaptureRow[] = (() => {
  const rows = formLabelRows();
  const zinc = { ...KITCHEN, name: "Zinc" };
  const [attic, garden] = [
    label(4, "Attic", { color: "#00aa44" }),
    label(3, "Garden", { description: "Seeds" }),
  ];
  return [
    ...rows,
    ["PATCH", "/api/labels/1", zinc, 200, { name: "Zinc" }],
    ["GET", "/api/labels/1", zinc],
    ["GET", "/api/labels", [attic, garden, TOOLS, zinc]],
  ];
})();

const page = (results: readonly Entity[]): Entity => ({
  count: results.length,
  next: null,
  previous: null,
  all: results.map((entity) => entity["id"]!),
  results: [...results],
});

/** Tag creates whose list answers carry `all`, the listed ids in list order, as Paperless-ngx's do. */
export const LISTED_ID_ROWS: readonly TimedCaptureRow[] = (() => {
  const harbour = label(3, "Harbour");
  const quarry = label(4, "Quarry");
  return [
    ["GET", "/api/tags/", page([KITCHEN, TOOLS])],
    ["GET", "/api/tags/1/", KITCHEN],
    ["POST", "/api/tags/", harbour, 201, { name: "Harbour" }],
    ["GET", "/api/tags/3/", harbour],
    ["GET", "/api/tags/", page([harbour, KITCHEN, TOOLS])],
    ["POST", "/api/tags/", quarry, 201, { name: "Quarry" }],
    ["GET", "/api/tags/4/", quarry],
    ["GET", "/api/tags/", page([harbour, KITCHEN, quarry, TOOLS])],
  ];
})();

const folder = (id: number, title: string, version = 1): Entity => ({
  id,
  title,
  version,
});

/**
 * One seeded folder, two creates that sort after it, and a rename that sorts first, as Grafana lists folders by
 * title: no read before the rename shows whether the folders are kept by title or in creation order.
 */
export const TITLE_ORDER_ROWS: readonly TimedCaptureRow[] = (() => {
  const rota = folder(1, "Lighthouse Rota");
  const alpha = folder(2, "Scratch Alpha");
  const beta = folder(3, "Scratch Beta");
  const renamed = folder(3, "Beta Renamed", 2);
  return [
    ["GET", "/api/folders", [rota]],
    ["GET", "/api/folders/1", rota],
    ["POST", "/api/folders", alpha, 200, { title: "Scratch Alpha" }],
    ["GET", "/api/folders/2", alpha],
    ["GET", "/api/folders", [rota, alpha]],
    ["POST", "/api/folders", beta, 200, { title: "Scratch Beta" }],
    ["GET", "/api/folders/3", beta],
    ["GET", "/api/folders", [rota, alpha, beta]],
    [
      "PUT",
      "/api/folders/3",
      renamed,
      200,
      { title: "Beta Renamed", version: 1 },
    ],
    ["GET", "/api/folders/3", renamed],
    ["GET", "/api/folders", [renamed, rota, alpha]],
  ];
})();

const OWNER = {
  id: 1,
  name: "Rea Admin",
  created: "2026-10-01T09:00:00Z",
};

/** A create answer before the application loads what it stored: the owner's unset values and an empty list spelled `[]` where reads spell `null`. */
const unloaded = (entity: Entity, at: number): Entity => ({
  ...entity,
  assignees: [],
  owner: { id: 1, name: "", created: "0001-01-01T00:00:00Z" },
  created: bookClock(at).replace("Z", ".123456789Z"),
});

const task = (id: number, title: string, at: number): Entity => ({
  id,
  title,
  done: false,
  assignees: null,
  owner: OWNER,
  created: bookClock(at),
});

/** Task creates whose answers show the owner and assignees unloaded, then a done flag whose answer spells empty assignees `[]`. */
export const UNLOADED_ANSWER_ROWS: readonly TimedCaptureRow[] = (() => {
  const seed = task(1, "Trim the wicks", 0);
  const first = task(2, "Order lamp oil", 2);
  const second = task(3, "Paint the rail", 5);
  const done = { ...first, done: true };
  return [
    ["GET", "/api/tasks", [seed]],
    ["GET", "/api/tasks/1", seed],
    [
      "POST",
      "/api/tasks",
      unloaded(first, 2),
      201,
      { title: "Order lamp oil" },
    ],
    ["GET", "/api/tasks/2", first],
    ["GET", "/api/tasks", [seed, first]],
    [
      "POST",
      "/api/tasks",
      unloaded(second, 5),
      201,
      { title: "Paint the rail" },
    ],
    ["GET", "/api/tasks/3", second],
    ["GET", "/api/tasks", [seed, first, second]],
    ["PATCH", "/api/tasks/2", { ...done, assignees: [] }, 200, { done: true }],
    ["GET", "/api/tasks/2", done],
    ["GET", "/api/tasks", [seed, done, second]],
  ];
})();

/** A tag as the application stores it: a text color it derives from the color, which no rule rebuilds. */
const painted = (id: number, name: string, color: string, text: string) => ({
  id,
  name,
  color,
  text_color: text,
});

/** Two tag creates whose derived text colors differ, then deletes of both, each read back as gone. */
export const DERIVED_TEXT_ROWS: readonly TimedCaptureRow[] = (() => {
  const seed = painted(1, "Inbox", "#2a9d8f", "#ffffff");
  const light = painted(2, "Light", "#a8dadc", "#000000");
  const dark = painted(3, "Dark", "#264653", "#ffffff");
  const { id: _light, text_color: _lightText, ...lightSent } = light;
  const { id: _dark, text_color: _darkText, ...darkSent } = dark;
  return [
    ["GET", "/api/tags", [seed]],
    ["GET", "/api/tags/1", seed],
    ["POST", "/api/tags", light, 201, lightSent],
    ["GET", "/api/tags/2", light],
    ["GET", "/api/tags", [seed, light]],
    ["POST", "/api/tags", dark, 201, darkSent],
    ["GET", "/api/tags/3", dark],
    ["GET", "/api/tags", [seed, light, dark]],
    ["DELETE", "/api/tags/2", "", 204],
    ["GET", "/api/tags/2", { detail: "Not found." }, 404],
    ["DELETE", "/api/tags/3", "", 204],
    ["GET", "/api/tags/3", { detail: "Not found." }, 404],
    ["GET", "/api/tags", [seed]],
  ];
})();

const contact = (
  id: number,
  fields: {
    readonly firstName: string | null;
    readonly lastName: string;
    readonly email: string | null;
  },
): Entity => ({
  id,
  ...fields,
  emailOptedOut: fields.email === null ? null : false,
});

/** A contact form's full create, then one with only the last name, whose empty members store as sent: `null` where the first stored a string, and an opt-out flag `null` where it stored `false`. */
export const MINIMAL_CONTACT_ROWS: readonly TimedCaptureRow[] = (() => {
  const seed = contact(1, {
    firstName: "Ada",
    lastName: "Finch",
    email: "ada@example.test",
  });
  const full = contact(2, {
    firstName: "Tomas",
    lastName: "Vey",
    email: "tomas@example.test",
  });
  const minimal = contact(3, {
    firstName: null,
    lastName: "Okafor",
    email: null,
  });
  const sent = ({ id: _id, ...members }: Entity) => members;
  return [
    ["GET", "/api/contacts", [seed]],
    ["GET", "/api/contacts/1", seed],
    ["POST", "/api/contacts", full, 201, sent(full)],
    ["GET", "/api/contacts/2", full],
    ["GET", "/api/contacts", [seed, full]],
    ["POST", "/api/contacts", minimal, 201, sent(minimal)],
    ["GET", "/api/contacts/3", minimal],
    ["GET", "/api/contacts", [seed, full, minimal]],
  ];
})();

/** The form label creates, then a bulk rename naming each label and its new name in an array, read back. */
export const BULK_RENAMED_LABEL_ROWS: readonly TimedCaptureRow[] = (() => {
  const rows = formLabelRows();
  const [attic, garden] = [
    label(4, "Attic", { color: "#00aa44" }),
    label(3, "Garden", { description: "Seeds" }),
  ];
  const zinc = { ...KITCHEN, name: "Zinc" };
  return [
    ...rows,
    ["PATCH", "/api/labels", [zinc], 200, [{ id: 1, name: "Zinc" }]],
    ["GET", "/api/labels/1", zinc],
    ["GET", "/api/labels", [attic, garden, TOOLS, zinc]],
  ];
})();

/** Notes created with text, then sent `null`, then left out and stored `""`, each read back. */
export const NOTE_DEFAULT_ROWS: readonly TimedCaptureRow[] = (() => {
  const note = (id: number, name: string, text: string | null) => ({
    id,
    name,
    note: text,
  });
  const seed = note(1, "Seed", "kept");
  const first = note(2, "First", "text");
  const second = note(3, "Second", null);
  const third = note(4, "Third", "");
  return [
    ["GET", "/api/notes", [seed]],
    ["GET", "/api/notes/1", seed],
    ["POST", "/api/notes", first, 201, { name: "First", note: "text" }],
    ["GET", "/api/notes/2", first],
    ["GET", "/api/notes", [seed, first]],
    ["POST", "/api/notes", second, 201, { name: "Second", note: null }],
    ["GET", "/api/notes/3", second],
    ["GET", "/api/notes", [seed, first, second]],
    ["POST", "/api/notes", third, 201, { name: "Third" }],
    ["GET", "/api/notes/4", third],
    ["GET", "/api/notes", [seed, first, second, third]],
  ];
})();

/**
 * Two seeded folders and two creates whose ids and titles both ascend, so either could be the order kept, then a
 * rename that sorts first by title.
 */
export const ID_OR_TITLE_ROWS: readonly TimedCaptureRow[] = (() => {
  const [alpha, bravo] = [folder(1, "Alpha"), folder(2, "Bravo")];
  const [charlie, delta] = [folder(3, "Charlie"), folder(4, "Delta")];
  const renamed = folder(4, "Aardvark", 2);
  return [
    ["GET", "/api/folders", [alpha, bravo]],
    ["GET", "/api/folders/1", alpha],
    ["POST", "/api/folders", charlie, 200, { title: "Charlie" }],
    ["GET", "/api/folders/3", charlie],
    ["GET", "/api/folders", [alpha, bravo, charlie]],
    ["POST", "/api/folders", delta, 200, { title: "Delta" }],
    ["GET", "/api/folders/4", delta],
    ["GET", "/api/folders", [alpha, bravo, charlie, delta]],
    ["PUT", "/api/folders/4", renamed, 200, { title: "Aardvark", version: 1 }],
    ["GET", "/api/folders/4", renamed],
    ["GET", "/api/folders", [renamed, alpha, bravo, charlie]],
  ];
})();
