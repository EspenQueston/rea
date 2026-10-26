import { isExactJsonNumber } from "../domain/exactJsonNumber.js";
import { safeParseJson } from "../domain/safeJson.js";
import { err, ok, type Result } from "../domain/result.js";
import type { BrowserScenarioSaveEntry } from "../domain/browserScenarioValues.js";

/** Bound decoded JSON before parsing; UTF-8 needs at most three bytes per UTF-16 code unit. */
export const MAX_SAVED_RESPONSE_CHARACTERS = 4_000_000;
export const MAX_SAVED_RESPONSE_BYTES = 3 * MAX_SAVED_RESPONSE_CHARACTERS;

interface ResponseValueIssue {
  readonly _tag: "ResponseValueIssue";
  readonly message: string;
}
const issue = (message: string): ResponseValueIssue => ({
  _tag: "ResponseValueIssue",
  message,
});

export interface ResponseValue {
  readonly entry: BrowserScenarioSaveEntry;
  readonly value: string | number;
}

/** Exact own-property lookup: an absent pointer remains distinct from a non-scalar value. */
export const responsePointerValue = (
  value: unknown,
  pointer: string,
): unknown => {
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
  return current;
};

/** Both bindings and source-body redaction use the same decoded values and exact-number policy. */
export const readResponseValues = (
  body: string | Uint8Array | undefined,
  entries: readonly BrowserScenarioSaveEntry[],
  missing: "fail" | "ignore",
): Result<readonly ResponseValue[], ResponseValueIssue> => {
  if (
    body === undefined ||
    (typeof body !== "string" && body.byteLength > MAX_SAVED_RESPONSE_BYTES)
  )
    return err(issue("the response is too large to save values from."));
  let text: string;
  try {
    text =
      typeof body === "string"
        ? body
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            body,
          );
  } catch {
    return err(
      issue(
        "the response is not valid UTF-8 JSON, so no value can be saved from it.",
      ),
    );
  }
  if (text.length > MAX_SAVED_RESPONSE_CHARACTERS)
    return err(issue("the response is too large to save values from."));
  const parsed = safeParseJson(text, (_key, value, context) =>
    typeof value === "number" && !isExactJsonNumber(value, context?.source)
      ? Number.NaN
      : value,
  );
  if (!parsed.ok)
    return err(
      issue("the response is not JSON, so no value can be saved from it."),
    );
  const selected: ResponseValue[] = [];
  for (const entry of entries) {
    const value = responsePointerValue(parsed.value, entry.json_pointer);
    if (value === undefined && missing === "ignore") continue;
    if (typeof value !== "string" && typeof value !== "number")
      return err(
        issue(
          `the response has no string or number at ${entry.json_pointer} to save as ${entry.name}.`,
        ),
      );
    if (typeof value === "number" && !Number.isFinite(value))
      return err(
        issue(
          `the number at ${entry.json_pointer} cannot be saved exactly (not finite or JSON conversion would lose precision).`,
        ),
      );
    selected.push({ entry, value });
  }
  return ok(selected);
};

interface ResponseBodySource {
  headers(): Readonly<Record<string, string>>;
  request(): { sizes?(): Promise<{ readonly responseBodySize: number }> };
  body(): Promise<Buffer>;
}

/** The caller owns deadline/cancellation; unknown decoded bounds never request a whole body. */
export const readBoundedResponseBody = async (
  response: ResponseBodySource,
  maxBytes: number,
): Promise<Result<Buffer, ResponseValueIssue>> => {
  const request = response.request();
  const size =
    request.sizes === undefined
      ? undefined
      : (await request.sizes()).responseBodySize;
  if (size !== undefined && size > maxBytes)
    return err(issue("the response is too large to save values from."));
  const encoding = response.headers()["content-encoding"]?.trim().toLowerCase();
  if (
    size === undefined ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    (encoding !== undefined && encoding !== "" && encoding !== "identity")
  )
    return err(
      issue(
        "the decoded response size cannot be bounded before reading it; this response body was not read.",
      ),
    );
  const body = await response.body();
  return body.length > maxBytes
    ? err(issue("the response is too large to save values from."))
    : ok(body);
};
