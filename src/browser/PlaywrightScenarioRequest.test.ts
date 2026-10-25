import type { Page, Route } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";

const ORIGIN = "https://app.example.test";

const scenario = (actions: readonly unknown[], secrets: unknown[] = []) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });

const requestStep = (fields: Record<string, unknown>) => ({
  step_id: "create",
  action: "request",
  method: "POST",
  path: "/api/folders",
  ...fields,
});

const issues = (actions: readonly unknown[], secrets: unknown[] = []) => {
  const parsed = browserScenarioSchema.safeParse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

describe("request step schema", () => {
  it("refuses repeated header names, User-Agent and line breaks in literal values or prefixes", () => {
    const literal = (value: string) => ({ source: "literal", value });
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-A", value: literal("one") },
            { name: "x-a", value: literal("two") },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("more than once"));
    expect(
      issues([
        requestStep({
          headers: [{ name: "User-Agent", value: literal("agent") }],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set"));
    expect(
      issues([requestStep({ expected_status: [200, 303] })]),
    ).toContainEqual(expect.stringContaining("3xx"));
    for (const header of [
      { name: "X-A", value: literal("a\r\nX-B: b") },
      { name: "X-A", value: literal("a"), prefix: "Bearer\n" },
    ])
      expect(issues([requestStep({ headers: [header] })])).toContainEqual(
        expect.stringContaining("line breaks"),
      );
  });

  it("accepts a same-origin request with query, headers and a JSON body", () => {
    const parsed = scenario(
      [
        requestStep({
          query: [{ name: "org", value: { source: "literal", value: "1" } }],
          headers: [
            {
              name: "X-CSRFToken",
              value: { source: "cookie", name: "csrftoken" },
            },
            {
              name: "Authorization",
              value: { source: "secret", secret_id: "token" },
              prefix: "Bearer ",
            },
          ],
          json: { title: "Scratch folder 1" },
          expected_status: [200, 201],
        }),
      ],
      [{ secret_id: "token", environment_variable: "APP_TOKEN" }],
    );
    expect(parsed.actions[0]).toMatchObject({
      action: "request",
      method: "POST",
      path: "/api/folders",
    });
  });

  it("refuses paths that leave the start origin", () => {
    for (const path of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://evil.test/",
      "/\n/[bad]",
    ])
      expect(issues([requestStep({ path })]).length, path).toBeGreaterThan(0);
  });

  it("refuses a body on GET, a header fetch cannot set and an undeclared secret", () => {
    expect(
      issues([requestStep({ method: "GET", json: { a: 1 } })]),
    ).toContainEqual(expect.stringContaining("cannot send a body"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "Cookie", value: { source: "literal", value: "a=b" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set this header"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-Key", value: { source: "secret", secret_id: "key" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("not declared"));
  });
});

interface FakeFetch {
  readonly url: string;
  readonly init: RequestInit;
}

const fakePage = (options: {
  readonly url?: string;
  /** The origin the page reports when the request is sent, if it moved after the check. */
  readonly sendingOrigin?: string;
  readonly cookies?: readonly { name: string; value: string }[];
  readonly cookieDelayMs?: number;
  readonly evaluateDelayMs?: number;
  readonly storage?: Record<string, string>;
}) => {
  const url = options.url ?? `${ORIGIN}/dashboard`;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => options.storage?.[key] ?? null,
  });
  vi.stubGlobal("location", {
    origin: options.sendingOrigin ?? new URL(url).origin,
  });
  return {
    route: async () => {},
    unroute: async () => {},
    url: () => url,
    context: () => ({
      cookies: async () => {
        if (options.cookieDelayMs !== undefined)
          await new Promise((resolve) =>
            setTimeout(resolve, options.cookieDelayMs),
          );
        return options.cookies ?? [];
      },
    }),
    evaluate: async <Arg, Result>(
      fn: (arg: Arg) => Result | Promise<Result>,
      arg: Arg,
    ): Promise<Result> => {
      if (options.evaluateDelayMs !== undefined)
        await new Promise((resolve) =>
          setTimeout(resolve, options.evaluateDelayMs),
        );
      return fn(arg);
    },
  } as unknown as Page;
};

const stubFetch = (status: number, bodies: readonly string[] = []) => {
  const calls: FakeFetch[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(bodies[calls.length - 1] ?? "{}", { status });
  });
  return calls;
};

const perform = async (
  page: Page,
  action: BrowserScenarioAction,
  secrets: BrowserScenarioSecrets,
) =>
  performPlaywrightScenarioAction({
    page,
    action,
    secrets,
    startOrigin: ORIGIN,
  });

const resolved = (parsed: ReturnType<typeof scenario>, environment = {}) => {
  const secrets = BrowserScenarioSecrets.resolve(parsed, environment);
  if (!secrets.ok) throw secrets.error;
  return secrets.value;
};

describe("request step execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the declared request through the page's fetch with its cookies", async () => {
    const calls = stubFetch(201);
    const parsed = scenario([
      requestStep({
        query: [{ name: "org", value: { source: "literal", value: "1" } }],
        json: { title: "Scratch folder 1" },
      }),
    ]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls).toEqual([
      {
        url: `${ORIGIN}/api/folders?org=1`,
        init: expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: [["content-type", "application/json"]],
          body: '{"title":"Scratch folder 1"}',
        }),
      },
    ]);
  });

  it("reads header values from a cookie and from stored JSON, and redacts them afterwards", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "X-CSRFToken",
            value: { source: "cookie", name: "csrftoken" },
          },
          {
            name: "Authorization",
            value: {
              source: "local_storage",
              key: "auth",
              json_pointer: "/token",
            },
            prefix: "Bearer ",
          },
        ],
      }),
    ]);
    const secrets = resolved(parsed);
    await perform(
      fakePage({
        cookies: [{ name: "csrftoken", value: "csrf-value-123" }],
        storage: { auth: JSON.stringify({ token: "jwt-value-456" }) },
      }),
      parsed.actions[0]!,
      secrets,
    );
    expect(calls[0]!.init.headers).toEqual([
      ["X-CSRFToken", "csrf-value-123"],
      ["Authorization", "Bearer jwt-value-456"],
    ]);
    const redacted = secrets.redact("csrf-value-123 and jwt-value-456");
    expect(redacted).not.toContain("csrf-value-123");
    expect(redacted).not.toContain("jwt-value-456");
    expect(redacted).toContain("[REDACTED:page:create.X-CSRFToken]");
  });

  it("refuses to run off the start origin, and fails on an unexpected status or a missing cookie", async () => {
    stubFetch(403);
    const parsed = scenario([requestStep({ expected_status: [200, 201] })]);
    const action = parsed.actions[0]!;
    await expect(
      perform(
        fakePage({ url: "https://other.test/" }),
        action,
        resolved(parsed),
      ),
    ).rejects.toThrow("start origin");
    await expect(
      perform(fakePage({}), action, resolved(parsed)),
    ).rejects.toThrow("answered 403; expected 200 or 201");
    const withCookie = scenario([
      requestStep({
        headers: [{ name: "X-T", value: { source: "cookie", name: "absent" } }],
      }),
    ]);
    await expect(
      perform(fakePage({}), withCookie.actions[0]!, resolved(withCookie)),
    ).rejects.toThrow("cookie absent is not set");
  });

  it("completes on any status when none is expected and reports fetch errors", async () => {
    stubFetch(500);
    const parsed = scenario([requestStep({})]);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).resolves.toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("Failed to fetch");
  });
});

describe("request dispatch boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends nothing when browser evaluation starts after the absolute deadline", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([requestStep({ timeout_ms: 5 })]);
    await expect(
      perform(
        fakePage({ evaluateDelayMs: 30 }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("ran out of time");
    expect(calls).toEqual([]);
  });

  it("guards dispatch after cancellation while evaluation was queued, and removes its route", async () => {
    const parsed = scenario([requestStep({})]);
    const controller = new AbortController();
    const page = fakePage({});
    let gate: ((route: Route) => Promise<void>) | undefined;
    vi.spyOn(page, "route").mockImplementation(async (_match, handler) => {
      gate = handler as typeof gate;
    });
    const unroute = vi.spyOn(page, "unroute");
    const sent = vi.fn();
    vi.spyOn(page, "evaluate").mockImplementation(async (fn, arg) => {
      controller.abort("abandoned while queued");
      return (fn as (arg: unknown) => unknown)(arg);
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (gate === undefined) throw new Error("Missing dispatch owner");
      await gate({
        request: () => ({
          method: () => init.method,
          postData: () => init.body ?? null,
        }),
        fallback: sent,
        abort: async () => {
          throw new Error("aborted at dispatch");
        },
      } as unknown as Route);
      return new Response("{}", { status: 200 });
    });
    await expect(
      performPlaywrightScenarioAction({
        page,
        action: parsed.actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted at dispatch");
    expect(sent).not.toHaveBeenCalled();
    expect(unroute).toHaveBeenCalledOnce();
  });

  it("refuses foreign-origin storage before reading its value", async () => {
    const calls = stubFetch(200);
    const read = vi.fn();
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: { source: "local_storage", key: "token" },
          },
        ],
      }),
    ]);
    const page = fakePage({ sendingOrigin: "https://other.test" });
    vi.stubGlobal("localStorage", { getItem: read });
    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("local storage");
    expect(read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("drains response chunks and releases the reader without materializing the body", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(8) })
      .mockResolvedValueOnce({ done: true });
    const releaseLock = vi.fn();
    const arrayBuffer = vi.fn();
    vi.stubGlobal("fetch", async () => ({
      status: 200,
      type: "basic",
      body: { getReader: () => ({ read, releaseLock }) },
      arrayBuffer,
    }));
    const parsed = scenario([requestStep({})]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(read).toHaveBeenCalledTimes(2);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("request step confinement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows no redirect and sends nothing once the page has left the start origin", async () => {
    const calls: FakeFetch[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        type: "opaqueredirect",
        status: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const parsed = scenario([requestStep({})]);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("request steps do not follow");
    expect(calls[0]!.init.redirect).toBe("manual");
    await expect(
      perform(
        fakePage({ sendingOrigin: "https://other.test" }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("the page moved");
    expect(calls).toHaveLength(1);
  });

  it("sends nothing when its time runs out while header values are read, or the step is cancelled", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        timeout_ms: 5,
        headers: [{ name: "X-T", value: { source: "cookie", name: "t" } }],
      }),
    ]);
    const cookies = [{ name: "t", value: "token-value-1" }];
    await expect(
      perform(
        fakePage({ cookies, cookieDelayMs: 30 }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("ran out of time");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      performPlaywrightScenarioAction({
        page: fakePage({ cookies }),
        action: scenario([requestStep({})]).actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow("ran out of time");
    expect(calls).toEqual([]);
  });

  it("appends query entries after the path's literal query without re-encoding it", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        path: "/api/items?flag&a=b%20c&s=x;y",
        query: [{ name: "q", value: { source: "literal", value: "a b" } }],
      }),
    ]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls[0]!.url).toBe(
      `${ORIGIN}/api/items?flag&a=b%20c&s=x;y&q=a%20b`,
    );
    for (const [path, sent] of [
      ["/api/items?", "/api/items?q=1"],
      ["/api/items#", "/api/items?q=1"],
      ["/api/items?a=1&", "/api/items?a=1&q=1"],
      ["/api/items?a=1#top", "/api/items?a=1&q=1"],
    ] as const) {
      const edge = scenario([
        requestStep({
          path,
          query: [{ name: "q", value: { source: "literal", value: "1" } }],
        }),
      ]);
      await perform(fakePage({}), edge.actions[0]!, resolved(edge));
      expect(calls.at(-1)!.url, path).toBe(`${ORIGIN}${sent}`);
    }
  });

  it("refuses page values a header cannot carry, and stored values it cannot read", async () => {
    const calls = stubFetch(200);
    const header = (value: Record<string, unknown>) =>
      scenario([requestStep({ headers: [{ name: "X-T", value }] })]);
    const cookie = header({ source: "cookie", name: "t" });
    await expect(
      perform(
        fakePage({ cookies: [{ name: "t", value: "a\r\nX-B: b" }] }),
        cookie.actions[0]!,
        resolved(cookie),
      ),
    ).rejects.toThrow("cannot carry");
    for (const [storage, pointer, message] of [
      [{}, undefined, "local storage has no auth"],
      [{ auth: "not json" }, "/token", "is not JSON"],
      [{ auth: '{"other":1}' }, "/token", "no string or number at /token"],
    ] as const) {
      const stored = header({
        source: "local_storage",
        key: "auth",
        ...(pointer === undefined ? {} : { json_pointer: pointer }),
      });
      await expect(
        perform(fakePage({ storage }), stored.actions[0]!, resolved(stored)),
      ).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
    const numeric = header({
      source: "local_storage",
      key: "auth",
      json_pointer: "/org",
    });
    await perform(
      fakePage({ storage: { auth: '{"org":42}' } }),
      numeric.actions[0]!,
      resolved(numeric),
    );
    expect(calls[0]!.init.headers).toEqual([["X-T", "42"]]);
  });
});

describe("page value redaction", () => {
  const secrets = () => resolved(scenario([requestStep({})]));

  it("keeps every admitted value redacted, even under a repeated or colliding label", () => {
    const held = secrets();
    held.admitPageValue("s.x-a", "first-secret-AAAA");
    held.admitPageValue("s.x-a", "second-secret-BBBB");
    held.admitPageValue("a.b.c", "third-secret-CCCC");
    held.admitPageValue("a.b.c", "fourth-secret-DDDD");
    const text = held.redact(
      "first-secret-AAAA second-secret-BBBB third-secret-CCCC fourth-secret-DDDD",
    );
    for (const value of ["AAAA", "BBBB", "CCCC", "DDDD"])
      expect(text).not.toContain(value);
  });

  it("keeps a value's first marker when later steps read it again", () => {
    const held = secrets();
    held.admitPageValue("create-1.X-CSRFToken", "csrf-token-value");
    held.admitPageValue("create-2.X-CSRFToken", "csrf-token-value");
    expect(held.redact("csrf-token-value")).toBe(
      "[REDACTED:page:create-1.X-CSRFToken]",
    );
  });

  it("redacts the value fetch sends when the stored one has surrounding spaces", () => {
    const held = secrets();
    held.admitPageValue("s.X-Tok", " padded-token-4f9e2a\t");
    expect(held.redact("X-Tok: padded-token-4f9e2a")).not.toContain(
      "padded-token-4f9e2a",
    );
  });

  it("does not redact values too short to tell from ids and ports", () => {
    const held = secrets();
    held.admitPageValue("s.X-Org-Id", "1");
    held.admitPageValue("s.X-Port", "3000");
    const text = "http://127.0.0.1:3000/api/items/12?page=1";
    expect(held.redact(text)).toBe(text);
  });
});

describe("saved value schema", () => {
  const saved = (name: string) => ({ source: "saved", name });
  const saveId = (stepId: string, name: string) =>
    requestStep({
      step_id: stepId,
      save: [{ name, json_pointer: "/id" }],
    });
  const clickSaving = (name: string) => ({
    step_id: "save-item",
    action: "click",
    locator: { kind: "role", role: "button", name: "Save" },
    save_response: {
      method: "POST",
      path: "/api/items",
      save: [{ name, json_pointer: "/id" }],
    },
  });
  const gotoItem = (url: string) => ({
    step_id: "open",
    action: "goto",
    destination: { url },
    wait_until: "load",
  });

  it("refuses a saved value no earlier step saves, wherever a step sends it", () => {
    const sendsItem = requestStep({
      step_id: "edit",
      method: "PUT",
      path: "/api/items/{saved:item}",
    });
    expect(issues([sendsItem])).toEqual([
      "Step edit sends saved value item, which no earlier step saves",
    ]);
    expect(issues([sendsItem, saveId("create", "item")])).toContainEqual(
      expect.stringContaining("which no earlier step saves"),
    );
    expect(issues([saveId("create", "item"), sendsItem])).toEqual([]);
    expect(issues([clickSaving("item"), sendsItem])).toEqual([]);
    for (const step of [
      gotoItem(`${ORIGIN}/items/{saved:item}`),
      gotoItem(`${ORIGIN}/items/%7Bsaved%3Aitem%7D`),
      requestStep({ path: "/api/items?parent={saved:item}" }),
      requestStep({ json: { list: [{ parent: "{saved:item}" }] } }),
      requestStep({ json: { note: "Copied from {saved:item}" } }),
      requestStep({ headers: [{ name: "X-Item", value: saved("item") }] }),
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: {
              source: "basic_credentials",
              parts: [saved("item"), { source: "literal", value: "x" }],
            },
          },
        ],
      }),
    ])
      expect(issues([step]), JSON.stringify(step)).toContainEqual(
        expect.stringContaining("sends saved value item"),
      );
  });

  it("sends other braces as written", () => {
    expect(
      issues([
        gotoItem(`${ORIGIN}/search/{q}`),
        requestStep({ path: "/api/items/{id}", json: { name: "{draft}" } }),
      ]),
    ).toEqual([]);
  });

  it("builds Basic credentials from page values and refuses undeclared secret parts", () => {
    const basic = (username: unknown, password: unknown) =>
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: { source: "basic_credentials", parts: [username, password] },
            prefix: "Basic ",
          },
        ],
      });
    expect(
      issues([
        basic(
          { source: "local_storage", key: "user", json_pointer: "/name" },
          { source: "cookie", name: "pw" },
        ),
      ]),
    ).toEqual([]);
    expect(
      issues([
        basic(
          { source: "literal", value: "admin" },
          { source: "secret", secret_id: "password" },
        ),
      ]),
    ).toContainEqual(expect.stringContaining("not declared"));
    const literal = { source: "literal", value: "admin" };
    expect(
      issues([
        requestStep({
          headers: [
            {
              name: "Authorization",
              value: { source: "basic_credentials", parts: [literal] },
            },
          ],
        }),
      ]).length,
    ).toBeGreaterThan(0);
  });

  it("requires a save_response to name a same-origin path and something to save", () => {
    const click = (saveResponse: unknown) => ({
      ...clickSaving("item"),
      save_response: saveResponse,
    });
    for (const path of ["//evil.test/api", "api/items", "https://evil.test/"])
      expect(
        issues([
          click({
            method: "POST",
            path,
            save: [{ name: "item", json_pointer: "/id" }],
          }),
        ]).length,
        path,
      ).toBeGreaterThan(0);
    expect(
      issues([click({ method: "POST", path: "/api/items", save: [] })]).length,
    ).toBeGreaterThan(0);
  });
});

describe("saved value execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends saved ids in the path and body with their saved type, and a saved secret only redacted", async () => {
    const calls = stubFetch(200, [
      '{"id":42,"session":{"token":"session-token-9f3e"}}',
    ]);
    const parsed = scenario([
      requestStep({
        json: { title: "Scratch folder 1" },
        save: [
          { name: "folder", json_pointer: "/id" },
          { name: "token", json_pointer: "/session/token", secret: true },
        ],
      }),
      requestStep({
        step_id: "move",
        method: "PUT",
        path: "/api/folders/{saved:folder}",
        json: {
          title: "Moved",
          parent: "{saved:folder}",
          note: "Moved into {saved:folder}",
        },
        headers: [
          {
            name: "Authorization",
            value: { source: "saved", name: "token" },
            prefix: "Bearer ",
          },
        ],
      }),
    ]);
    const secrets = resolved(parsed);
    const page = fakePage({});
    for (const action of parsed.actions) await perform(page, action, secrets);
    expect(calls[1]).toEqual({
      url: `${ORIGIN}/api/folders/42`,
      init: expect.objectContaining({
        method: "PUT",
        headers: [
          ["Authorization", "Bearer session-token-9f3e"],
          ["content-type", "application/json"],
        ],
        body: '{"title":"Moved","parent":42,"note":"Moved into 42"}',
      }),
    });
    expect(secrets.redact("folder 42 with session-token-9f3e")).toBe(
      "folder 42 with [REDACTED:page:create.token]",
    );
  });

  it("fails a step whose response holds no value to save", async () => {
    stubFetch(200, ['{"items":[]}', "not json"]);
    const parsed = scenario([
      requestStep({ save: [{ name: "folder", json_pointer: "/id" }] }),
    ]);
    const secrets = resolved(parsed);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow("no string or number at /id to save as folder");
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow("is not JSON");
    expect(() => secrets.savedValue("folder")).toThrow();
  });

  it("encodes Basic credentials read from local storage and a cookie, and redacts both parts", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: {
              source: "basic_credentials",
              parts: [
                {
                  source: "local_storage",
                  key: "user",
                  json_pointer: "/name",
                },
                { source: "cookie", name: "api_key" },
              ],
            },
            prefix: "Basic ",
          },
        ],
      }),
    ]);
    const secrets = resolved(parsed);
    await perform(
      fakePage({
        cookies: [{ name: "api_key", value: "cookie-key-5d1c" }],
        storage: { user: JSON.stringify({ name: "operator-7" }) },
      }),
      parsed.actions[0]!,
      secrets,
    );
    const encoded = Buffer.from("operator-7:cookie-key-5d1c").toString(
      "base64",
    );
    expect(calls[0]!.init.headers).toEqual([
      ["Authorization", `Basic ${encoded}`],
    ]);
    const redacted = secrets.redact(`${encoded} operator-7 cookie-key-5d1c`);
    for (const value of [encoded, "operator-7", "cookie-key-5d1c"])
      expect(redacted).not.toContain(value);
  });

  it("fills a goto destination's placeholders, percent-encoded", async () => {
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
      {
        step_id: "open",
        action: "goto",
        destination: { url: `${ORIGIN}/items/{saved:item}/edit` },
        wait_until: "load",
      },
    ]);
    const secrets = resolved(parsed);
    secrets.save("create.item", "item", "a b/c", false);
    const goto = vi.fn(async () => null);
    await perform({ goto } as unknown as Page, parsed.actions[1]!, secrets);
    expect(goto).toHaveBeenCalledWith(
      `${ORIGIN}/items/a%20b%2Fc/edit`,
      expect.anything(),
    );
  });
});

describe("saving from a UI step's response", () => {
  interface FakeResponse {
    readonly method: string;
    readonly url: string;
    readonly status: number;
    readonly body: string;
  }

  /** A page whose click triggers the given responses; waitForResponse resolves with the first one it names. */
  const uiPage = (responses: readonly FakeResponse[]) => {
    const order: string[] = [];
    const page = {
      getByRole: () => ({
        click: async () => {
          order.push("click");
        },
      }),
      waitForResponse: async (
        names: (response: unknown) => boolean,
        options: { timeout?: number },
      ) => {
        order.push(`wait ${String(options.timeout)}`);
        await Promise.resolve();
        const found = responses
          .map((response) => ({
            request: () => ({ method: () => response.method }),
            url: () => response.url,
            status: () => response.status,
            text: async () => response.body,
          }))
          .find(names);
        if (found === undefined) throw new Error("Timeout exceeded");
        return found;
      },
    } as unknown as Page;
    return { page, order };
  };

  const clickSaving = (path: string) =>
    scenario([
      {
        step_id: "save-item",
        action: "click",
        timeout_ms: 5000,
        locator: { kind: "role", role: "button", name: "Save" },
        save_response: {
          method: "POST",
          path,
          save: [{ name: "item", json_pointer: "/id" }],
        },
      },
    ]);

  it("waits before clicking, and saves from the response the step names", async () => {
    const parsed = clickSaving("/api/lists/{*}/items");
    const secrets = resolved(parsed);
    const { page, order } = uiPage([
      {
        method: "GET",
        url: `${ORIGIN}/api/lists/3/items`,
        status: 200,
        body: '{"id":"read"}',
      },
      {
        method: "POST",
        url: `https://other.test/api/lists/3/items`,
        status: 201,
        body: '{"id":"foreign"}',
      },
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/3/4/items`,
        status: 201,
        body: '{"id":"deeper"}',
      },
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/3/items?draft=1`,
        status: 201,
        body: '{"id":"item-7"}',
      },
    ]);
    await perform(page, parsed.actions[0]!, secrets);
    expect(order).toEqual(["wait 5000", "click"]);
    expect(secrets.savedValue("item")).toBe("item-7");
  });

  it("fails the step when no named response arrives or it is not 2xx", async () => {
    const parsed = clickSaving("/api/items");
    await expect(
      perform(uiPage([]).page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow(
      "no POST /api/items response arrived before the step's timeout",
    );
    await expect(
      perform(
        uiPage([
          {
            method: "POST",
            url: `${ORIGIN}/api/items`,
            status: 422,
            body: '{"id":"x"}',
          },
        ]).page,
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow(
      "answered 422; values are saved only from a 2xx response",
    );
  });
});
