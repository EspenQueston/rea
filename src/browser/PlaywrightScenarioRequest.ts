import type { Page, Route } from "playwright-core";

import {
  HEADER_FIELD_VALUE,
  type BrowserScenarioAction,
  type BrowserScenarioRequestHeader,
} from "../domain/browserScenarioValues.js";
import type { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";

type RequestAction = Extract<BrowserScenarioAction, { action: "request" }>;

/** What the page's fetch returned; a redirect is not followed, so its status is unknown. */
type PageResponse =
  | { readonly status: number; readonly body?: string }
  | { readonly redirected: true }
  | { readonly left: string }
  | { readonly error: string };

/** A request step that could not be sent or did not answer as expected. */
export class ScenarioRequestError extends Error {
  override readonly name = "ScenarioRequestError";
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The string or number at a JSON pointer, as text. */
const pointerText = (value: unknown, pointer: string): string | undefined => {
  const found = pointerValue(value, pointer);
  return found === undefined ? undefined : String(found);
};

/** The string or number at a JSON pointer. */
const pointerValue = (
  value: unknown,
  pointer: string,
): string | number | undefined => {
  let current = value;
  if (pointer !== "")
    for (const token of pointer.slice(1).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(current) && /^(?:0|[1-9][0-9]*)$/u.test(key))
        current = current[Number(key)];
      else if (
        typeof current === "object" &&
        current !== null &&
        Object.hasOwn(current, key)
      )
        current = (current as Record<string, unknown>)[key];
      else return undefined;
    }
  return typeof current === "string" || typeof current === "number"
    ? current
    : undefined;
};

/** Resolve one header value; values read from the page are redacted from later records. */
const headerValue = async (
  step: {
    readonly page: Page;
    readonly url: URL;
    readonly stepId: string;
    readonly secrets: BrowserScenarioSecrets;
  },
  header: BrowserScenarioRequestHeader,
): Promise<string> => {
  const { page, url, stepId, secrets } = step;
  const { value } = header;
  if (
    value.source === "literal" ||
    value.source === "secret" ||
    value.source === "saved"
  )
    return secrets.value(value);
  if (value.source === "basic_credentials") {
    const encoded = Buffer.from(
      `${secrets.value(value.username)}:${secrets.value(value.password)}`,
    ).toString("base64");
    secrets.admitPageValue(`${stepId}.${header.name}`, encoded);
    return encoded;
  }
  let read: string | undefined;
  if (value.source === "cookie") {
    const cookies = await page.context().cookies(url.href);
    read = cookies.find((cookie) => cookie.name === value.name)?.value;
    if (read === undefined)
      throw new ScenarioRequestError(
        `Request step ${stepId}: cookie ${value.name} is not set for ${url.origin}.`,
      );
  } else {
    const stored = await page.evaluate(
      ({ key, origin }) => {
        if (
          (globalThis as { readonly location?: { origin: string } }).location
            ?.origin !== origin
        )
          throw new Error(
            "The page moved off the start origin before its local storage was read.",
          );
        return (
          (
            globalThis as {
              readonly localStorage?: { getItem(key: string): string | null };
            }
          ).localStorage?.getItem(key) ?? null
        );
      },
      { key: value.key, origin: url.origin },
    );
    if (stored === null)
      throw new ScenarioRequestError(
        `Request step ${stepId}: local storage has no ${value.key} on ${url.origin}.`,
      );
    if (value.json_pointer === undefined) read = stored;
    else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch {
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} is not JSON.`,
        );
      }
      read = pointerText(parsed, value.json_pointer);
      if (read === undefined)
        throw new ScenarioRequestError(
          `Request step ${stepId}: local storage ${value.key} has no string or number at ${value.json_pointer}.`,
        );
    }
  }
  secrets.admitPageValue(`${stepId}.${header.name}`, read);
  return read;
};

/** Append declared query entries after any literal query the path carries, leaving that query as written. */
const withQuery = (
  url: URL,
  entries: readonly (readonly [string, string])[],
): string => {
  if (entries.length === 0) return url.href;
  const added = entries
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    )
    .join("&");
  // fetch drops the fragment; cut it at its "#" even when nothing follows it.
  const hash = url.href.indexOf("#");
  const base = hash < 0 ? url.href : url.href.slice(0, hash);
  const separator = !base.includes("?")
    ? "?"
    : base.endsWith("?") || base.endsWith("&")
      ? ""
      : "&";
  return `${base}${separator}${added}`;
};

/** What a request step sends: the URL, the origin it must be sent from, and the call. */
interface PageRequest {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: string | undefined;
  readonly deadline: number | undefined;
  /** Return the response text, for a step that saves values from it. */
  readonly read: boolean;
}

/** The largest response text a request step saves values from. */
const MAX_SAVED_RESPONSE_CHARACTERS = 4_000_000;

/** Send the request with the page's own fetch, from the page's main world, and read the whole answer. */
const sendFromPage = (
  page: Page,
  request: PageRequest,
): Promise<PageResponse> =>
  page.evaluate(async (request): Promise<PageResponse> => {
    // The page may have navigated since the origin check; never send from another origin.
    const here = (globalThis as { readonly location?: { origin: string } })
      .location?.origin;
    if (here !== request.origin) return { left: String(here) };
    if (
      (
        globalThis as {
          readonly navigator?: { serviceWorker?: { controller?: unknown } };
        }
      ).navigator?.serviceWorker?.controller
    )
      return {
        error:
          "Request steps require a page without a controlling service worker so cancellation can guard dispatch.",
      };
    const remaining =
      request.deadline === undefined
        ? undefined
        : request.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0)
      return { error: "The request ran out of time before it was sent." };
    const controller = new AbortController();
    const timer =
      remaining === undefined
        ? undefined
        : setTimeout(() => controller.abort(), remaining);
    try {
      const answer = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: "same-origin",
        redirect: "manual",
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (answer.type === "opaqueredirect") return { redirected: true };
      if (request.read) {
        const text = await answer.text();
        return { status: answer.status, body: text };
      }
      const reader = answer.body?.getReader();
      if (reader !== undefined)
        try {
          while (!(await reader.read()).done) {
            // Wait for completion without retaining a second response body.
          }
        } finally {
          reader.releaseLock();
        }
      return { status: answer.status };
    } catch (cause: unknown) {
      return {
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, request);

/**
 * Send one request from the page with its own fetch, cookies and session, as
 * the application's frontend would, and read the whole response so the
 * capture can record it. The page must be on the scenario's start origin.
 */
export const performScenarioRequest = async (input: {
  readonly page: Page;
  readonly action: RequestAction;
  readonly secrets: BrowserScenarioSecrets;
  readonly startOrigin: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> => {
  const { page, action, secrets, startOrigin, signal } = input;
  const deadline =
    action.timeout_ms === undefined
      ? undefined
      : Date.now() + action.timeout_ms;
  const pageOrigin = originOf(page.url());
  if (pageOrigin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; navigate back to it with a goto step first.`,
    );
  const path = action.path.replace(
    /\{([A-Za-z][A-Za-z0-9._-]*)\}/gu,
    (placeholder, name: string) => {
      const param = action.path_params.find((entry) => entry.name === name);
      return param === undefined
        ? placeholder
        : encodeURIComponent(secrets.value(param.value));
    },
  );
  const url = new URL(path, startOrigin);
  if (url.origin !== startOrigin)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} must stay on the start origin ${startOrigin}.`,
    );
  const target = withQuery(
    url,
    action.query.map(({ name, value }) => [name, secrets.value(value)]),
  );
  const step = { page, url, stepId: action.step_id, secrets };
  const headers: [string, string][] = [];
  for (const header of action.headers) {
    const value = `${header.prefix ?? ""}${await headerValue(step, header)}`;
    if (!HEADER_FIELD_VALUE.test(value))
      throw new ScenarioRequestError(
        `Request step ${action.step_id}: the ${header.name} value holds characters a header cannot carry, such as a line break.`,
      );
    headers.push([header.name, value]);
  }
  const hasContentType = headers.some(
    ([name]) => name.toLowerCase() === "content-type",
  );
  if (action.json !== undefined && !hasContentType)
    headers.push(["content-type", "application/json"]);
  // A step the boundary abandoned, or whose time ran out while values were read, sends nothing.
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (signal?.aborted === true || (remaining !== undefined && remaining <= 0))
    throw new ScenarioRequestError(
      `Request step ${action.step_id} ran out of time before its request was sent.`,
    );
  const json = withJsonValues(action, secrets);
  const request = {
    url: target,
    origin: startOrigin,
    method: action.method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    deadline,
    read: action.save.length > 0,
  };
  // The browser can queue evaluate behind a busy page. Keep a host-side gate
  // until that evaluation settles, including after the step boundary stops
  // waiting. A queued fetch then observes live cancellation at dispatch.
  const dispatchUrl = new URL(target);
  dispatchUrl.hash = "";
  const matches = (url: URL): boolean => url.href === dispatchUrl.href;
  const gate = async (route: Route): Promise<void> => {
    const sent = route.request();
    if (
      sent.method() !== request.method ||
      sent.postData() !== (request.body ?? null)
    ) {
      await route.fallback();
      return;
    }
    if (
      signal?.aborted === true ||
      (deadline !== undefined && Date.now() >= deadline)
    )
      await route.abort("aborted");
    else await route.fallback();
  };
  await page.route(matches, gate);
  let response: PageResponse;
  try {
    response = await sendFromPage(page, request);
  } finally {
    await page.unroute(matches, gate);
  }
  if ("error" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} failed in the page: ${response.error}`,
    );
  if ("left" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} runs from a page on the start origin ${startOrigin}; the page moved before the request was sent.`,
    );
  if ("redirected" in response)
    throw new ScenarioRequestError(
      `Request step ${action.step_id} was answered with a redirect, which request steps do not follow; a write may already have been applied. The capture records the redirect and, with header values selected, its Location.`,
    );
  if (
    action.expected_status !== undefined &&
    !action.expected_status.includes(response.status)
  )
    throw new ScenarioRequestError(
      `Request step ${action.step_id} answered ${String(response.status)}; expected ${action.expected_status.join(" or ")}.`,
    );
  if (action.save.length > 0) saveValues(action, response.body, secrets);
};

/** The step's JSON body with its `json_values` set at their pointers; a saved value keeps its JSON type. */
const withJsonValues = (
  action: RequestAction,
  secrets: BrowserScenarioSecrets,
): unknown => {
  if (action.json_values.length === 0) return action.json;
  const body: unknown = structuredClone(action.json ?? {});
  for (const { json_pointer, value } of action.json_values) {
    const tokens = json_pointer
      .slice(1)
      .split("/")
      .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
    const last = tokens.pop()!;
    let parent: unknown = body;
    for (const token of tokens)
      parent =
        parent !== null && typeof parent === "object"
          ? (parent as Record<string, unknown>)[token]
          : undefined;
    if (parent === null || typeof parent !== "object")
      throw new ScenarioRequestError(
        `Request step ${action.step_id}: the JSON body has no object or array at ${json_pointer}'s parent.`,
      );
    (parent as Record<string, unknown>)[last] =
      value.source === "saved"
        ? secrets.savedValue(value.name)
        : secrets.value(value);
  }
  return body;
};

/** Save the values the step names from its JSON response, for later request steps. */
const saveValues = (
  action: RequestAction,
  body: string | undefined,
  secrets: BrowserScenarioSecrets,
): void => {
  if (body === undefined || body.length > MAX_SAVED_RESPONSE_CHARACTERS)
    throw new ScenarioRequestError(
      `Request step ${action.step_id}: the response is too large to save values from.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ScenarioRequestError(
      `Request step ${action.step_id}: the response is not JSON, so no value can be saved from it.`,
    );
  }
  for (const { name, json_pointer, secret } of action.save) {
    const value = pointerValue(parsed, json_pointer);
    if (value === undefined)
      throw new ScenarioRequestError(
        `Request step ${action.step_id}: the response has no string or number at ${json_pointer} to save as ${name}.`,
      );
    secrets.save(`${action.step_id}.${name}`, name, value, secret);
  }
};
