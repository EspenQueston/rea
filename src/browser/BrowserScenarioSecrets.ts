import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { createHash } from "node:crypto";

import type { BrowserScenario } from "../domain/browserScenario.js";
import type {
  BrowserScenarioUrl,
  BrowserScenarioRequestValue,
  BrowserScenarioValue,
} from "../domain/browserScenarioValues.js";
import {
  sanitizeBrowserUrl,
  type SanitizedBrowserUrl,
} from "../domain/browserObservation.js";
import type { BrowserStorageValueFingerprint } from "../domain/browserScenarioCaptureValues.js";

const REDACTION_PREFIX = "[REDACTED:";

/** Page values shorter than this are not redacted: redacting them would rewrite ids, ports and hosts throughout the capture. */
export const MIN_REDACTED_PAGE_VALUE_LENGTH = 8;

/** The most saved-value text a scenario keeps at once, with the redaction spellings of values saved as secret: as much as one saved response can carry. */
export const MAX_RETAINED_SAVED_CHARACTERS = 4_000_000;

const encodedSecretValues = (secret: string): ReadonlySet<string> =>
  new Set([
    encodeURIComponent(secret),
    new URLSearchParams([["value", secret]]).toString().slice("value=".length),
  ]);

type SecretSpellings = "url" | "text";
interface SecretPattern {
  readonly text: string;
  readonly searchText: string;
  readonly percentInsensitive: boolean;
}
interface SecretReplacement extends SecretPattern {
  readonly id: string;
}
interface SecretNeedle {
  readonly id: string;
  readonly needle: Buffer;
  readonly percentInsensitive: boolean;
  readonly marker: Buffer;
}

const normalizePercentEscapes = (value: string): string => {
  if (!value.includes("%")) return value;
  return value.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toLowerCase());
};

const secretPatterns = (
  secret: string,
  spellings: SecretSpellings,
): readonly SecretPattern[] => {
  if (secret === "") return [];
  const patterns: SecretPattern[] = [
    { text: secret, searchText: secret, percentInsensitive: false },
    ...[...encodedSecretValues(secret)].map((text) => ({
      text,
      searchText: normalizePercentEscapes(text),
      percentInsensitive: true,
    })),
  ];
  if (spellings === "text")
    patterns.push({
      text: JSON.stringify(secret).slice(1, -1),
      searchText: JSON.stringify(secret).slice(1, -1),
      percentInsensitive: false,
    });
  const seen = new Set<string>();
  return patterns.filter(({ text, percentInsensitive }) => {
    if (text === "") return false;
    const key = `${percentInsensitive ? "percent" : "literal"}:${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The code units a secret's redaction spellings keep, each distinct spelling once. */
const spellingUnits = (secret: string): number =>
  [
    ...new Set(
      [
        ...secretPatterns(secret, "text"),
        ...secretPatterns(secret, "url"),
      ].flatMap(({ text, searchText }) => [text, searchText]),
    ),
  ].reduce((units, spelling) => units + spelling.length, 0);

const declaredPatterns = (
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
): readonly SecretPattern[] => {
  const seen = new Set<string>();
  return [...values.values()]
    .flatMap((secret) => secretPatterns(secret, spellings))
    .filter(({ text, percentInsensitive }) => {
      const key = `${percentInsensitive ? "percent" : "literal"}:${text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const secretReplacements = (
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
): readonly SecretReplacement[] =>
  [...values]
    .flatMap(([id, secret]) =>
      secretPatterns(secret, spellings).map((pattern) => ({ id, ...pattern })),
    )
    .sort(
      (left, right) =>
        right.text.length - left.text.length ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );

const normalizePercentEscapesBytes = (value: Buffer): Buffer => {
  if (value.indexOf(37) < 0) return value;
  const normalized = Buffer.from(value);
  for (let index = 0; index + 2 < normalized.length; index += 1)
    if (
      normalized[index] === 37 &&
      isHexByte(normalized[index + 1]) &&
      isHexByte(normalized[index + 2])
    ) {
      normalized[index + 1] = lowercaseHexByte(normalized[index + 1]!);
      normalized[index + 2] = lowercaseHexByte(normalized[index + 2]!);
      index += 2;
    }
  return normalized;
};

const isHexByte = (value: number | undefined): boolean =>
  value !== undefined &&
  ((value >= 48 && value <= 57) ||
    (value >= 65 && value <= 70) ||
    (value >= 97 && value <= 102));

const lowercaseHexByte = (value: number): number =>
  value >= 65 && value <= 70 ? value + 32 : value;

const patternMatches = (
  value: string,
  normalizedValue: string,
  pattern: SecretPattern,
): boolean =>
  (pattern.percentInsensitive ? normalizedValue : value).includes(
    pattern.searchText,
  );

const containsSecretPattern = (
  value: string,
  normalizedValue: string,
  patterns: readonly SecretPattern[],
): boolean => {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) =>
    patternMatches(value, normalizedValue, pattern),
  );
};

const containsSecretBytePattern = (
  value: Buffer,
  normalizedValue: Buffer,
  needles: readonly SecretNeedle[],
): boolean =>
  needles.some((needle) =>
    (needle.percentInsensitive ? normalizedValue : value).includes(
      needle.needle,
    ),
  );

/** Pick a marker that does not itself contain a declared secret spelling. */
const redactionMarker = (
  id: string,
  patterns: readonly SecretPattern[],
): string => {
  const candidates = [`${REDACTION_PREFIX}${id}]`, "[REDACTED]", "…", ""];
  return (
    candidates.find((candidate) =>
      patterns.every(
        (pattern) =>
          !patternMatches(
            candidate,
            normalizePercentEscapes(candidate),
            pattern,
          ),
      ),
    ) ?? ""
  );
};

const replaceSecretLiterals = (
  value: string,
  replacements: readonly SecretReplacement[],
  patterns: readonly SecretPattern[],
): string => {
  const normalizedValue = replacements.some(
    ({ percentInsensitive }) => percentInsensitive,
  )
    ? normalizePercentEscapes(value)
    : value;
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let next:
      | ((typeof replacements)[number] & { readonly index: number })
      | undefined;
    for (const replacement of replacements) {
      const search = replacement.searchText;
      const view = replacement.percentInsensitive ? normalizedValue : value;
      const index = view.indexOf(search, offset);
      if (
        index >= 0 &&
        (next === undefined ||
          index < next.index ||
          (index === next.index && replacement.text.length > next.text.length))
      )
        next = { ...replacement, index };
    }
    if (next === undefined) break;
    const marker = redactionMarker(next.id, patterns);
    parts.push(value.slice(offset, next.index), marker);
    offset = next.index + next.text.length;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(offset));
  return parts.join("");
};

const secretNeedles = (
  replacements: readonly SecretReplacement[],
  patterns: readonly SecretPattern[],
): SecretNeedle[] =>
  replacements.map((pattern) => ({
    id: pattern.id,
    needle: Buffer.from(pattern.searchText),
    percentInsensitive: pattern.percentInsensitive,
    marker: Buffer.from(redactionMarker(pattern.id, patterns)),
  }));

/** Resolved secret values kept only for one in-memory scenario session. */
export class BrowserScenarioSecrets {
  private urlPatterns: readonly SecretPattern[] = [];
  private textPatterns: readonly SecretPattern[] = [];
  private urlReplacements: readonly SecretReplacement[] = [];
  private textReplacements: readonly SecretReplacement[] = [];
  private textNeedles: readonly SecretNeedle[] = [];
  private redactionCostPerCharacter = 8;

  private constructor(private readonly values: Map<string, string>) {
    this.compile();
  }

  private compile(): void {
    const values = this.values;
    this.urlPatterns = declaredPatterns(values, "url");
    this.textPatterns = declaredPatterns(values, "text");
    this.urlReplacements = secretReplacements(values, "url");
    this.textReplacements = secretReplacements(values, "text");
    this.textNeedles = secretNeedles(this.textReplacements, this.textPatterns);
    this.redactionCostPerCharacter = 8;
    for (const [replacements, patterns] of [
      [this.textReplacements, this.textPatterns],
      [this.urlReplacements, this.urlPatterns],
    ] as const)
      for (const replacement of replacements)
        this.redactionCostPerCharacter = Math.max(
          this.redactionCostPerCharacter,
          8 +
            (Buffer.byteLength(redactionMarker(replacement.id, patterns)) * 8 +
              128) /
              replacement.text.length,
        );
  }

  /**
   * Redact a value a request step read from the page, such as a CSRF cookie
   * or a stored bearer token, from everything recorded after it, as a
   * declared secret is. The label names it in redaction markers; a value
   * already redacted keeps its first marker, and a value shorter than
   * {@link MIN_REDACTED_PAGE_VALUE_LENGTH} is not redacted.
   */
  admitPageValue(label: string, value: string): void {
    this.admit(label, value, MIN_REDACTED_PAGE_VALUE_LENGTH);
  }

  /** Redact a credential a step built or a value it saved as secret from everything recorded after it, whatever its length, as a declared secret is. */
  admitCredential(label: string, value: string): void {
    this.admit(label, value, 1);
  }

  private admit(label: string, value: string, shortest: number): void {
    // fetch sends a header value without surrounding spaces and tabs, so that is the spelling records hold.
    const sent = value.replace(/^[\t ]+|[\t ]+$/gu, "");
    if (sent !== value) this.admit(label, sent, shortest);
    if (value.length < shortest) return;
    for (const held of this.values.values()) if (held === value) return;
    let id = `page:${label}`;
    for (let suffix = 2; this.values.has(id); suffix += 1)
      id = `page:${label}~${String(suffix)}`;
    this.values.set(id, value);
    this.compile();
  }

  static resolve(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
  ): Result<BrowserScenarioSecrets, AnalysisInputError> {
    const values = new Map<string, string>();
    for (const [index, declaration] of scenario.secrets.entries()) {
      const value = environment[declaration.environment_variable];
      if (
        !Object.hasOwn(environment, declaration.environment_variable) ||
        typeof value !== "string"
      )
        return err(
          new AnalysisInputError(
            "capture_browser_scenario",
            {
              userMessage: `Set environment variable ${declaration.environment_variable} for browser scenario secret ${declaration.secret_id} in the environment that starts REA, then retry.`,
            },
            [
              {
                path: ["secrets", index, "environment_variable"],
                reason: "missing_argument",
                message: `Environment variable ${declaration.environment_variable} is not set for declared secret ${declaration.secret_id}.`,
                expected: {
                  secret_id: declaration.secret_id,
                  environment_variable: declaration.environment_variable,
                },
              },
            ],
          ),
        );
      values.set(declaration.secret_id, value);
    }
    return ok(new BrowserScenarioSecrets(values));
  }

  /** Values steps saved from JSON responses, by name, as strings or numbers. */
  private readonly saved = new Map<string, string | number>();

  /** Code units the current saved values keep, and those the redaction spellings of secret saves keep for the rest of the scenario. */
  private savedUnits = 0;
  private secretSpellingUnits = 0;

  /** Keep a value a step saved from a JSON response; a secret one is redacted from everything recorded after it. Refused before it is kept when the scenario would hold more than {@link MAX_RETAINED_SAVED_CHARACTERS}. */
  save(
    label: string,
    name: string,
    value: string | number,
    secret: boolean,
  ): void {
    const text = String(value);
    const replaced = this.saved.get(name);
    const savedUnits =
      this.savedUnits -
      (replaced === undefined ? 0 : String(replaced).length) +
      text.length;
    let kept = savedUnits + this.secretSpellingUnits;
    const spellings =
      secret && kept <= MAX_RETAINED_SAVED_CHARACTERS
        ? this.admittedSpellingUnits(text)
        : 0;
    kept += spellings;
    if (kept > MAX_RETAINED_SAVED_CHARACTERS)
      throw new Error(
        `${name} cannot be saved: the scenario would keep more than ${String(MAX_RETAINED_SAVED_CHARACTERS)} characters of saved values.`,
      );
    this.saved.set(name, value);
    this.savedUnits = savedUnits;
    this.secretSpellingUnits += spellings;
    if (secret) this.admitCredential(label, text);
  }

  /** The code units of the redaction spellings admitting `value` as a credential adds: it and its trimmed spelling, each unless already held. */
  private admittedSpellingUnits(value: string): number {
    const held = new Set(this.values.values());
    return [...new Set([value.replace(/^[\t ]+|[\t ]+$/gu, ""), value])]
      .filter((candidate) => candidate.length > 0 && !held.has(candidate))
      .reduce((units, candidate) => units + spellingUnits(candidate), 0);
  }

  /** A saved value with the JSON type it was saved with. */
  savedValue(name: string): string | number {
    const value = this.saved.get(name);
    if (value === undefined) throw new Error(`No earlier step saved ${name}`);
    return value;
  }

  value(source: BrowserScenarioValue | BrowserScenarioRequestValue): string {
    if (source.source === "literal") return source.value;
    if (source.source === "saved") return String(this.savedValue(source.name));
    const value = this.values.get(source.secret_id);
    if (value === undefined)
      throw new Error("Validated browser secret was not resolved");
    return value;
  }

  url(destination: BrowserScenarioUrl): string {
    const url = new URL(destination.url);
    for (const { name, value } of destination.query)
      url.searchParams.append(name, this.value(value));
    return url.href;
  }

  /** Conservative preflight for output expansion and per-match part arrays.
   * Callers measuring untrusted observations must reserve this cost before
   * invoking redaction. A one-byte secret can otherwise expand every byte.
   */
  redactionAllocationCost(length: number): number {
    return Math.ceil(length * this.redactionCostPerCharacter);
  }

  redact(value: string): string {
    const patterns = this.textPatterns;
    if (patterns.length === 0) return value;
    const output = replaceSecretLiterals(
      value,
      this.textReplacements,
      patterns,
    );
    return containsSecretPattern(
      output,
      normalizePercentEscapes(output),
      patterns,
    )
      ? ""
      : output;
  }

  /** Replace declared UTF-8, URI/form, and JSON-escaped secret spellings. */
  redactBytes(value: Buffer): Buffer {
    const patterns = this.textPatterns;
    if (patterns.length === 0) return value;
    const candidates = this.textNeedles;
    const hasPercentPatterns = candidates.some(
      ({ percentInsensitive }) => percentInsensitive,
    );
    const normalizedValue =
      hasPercentPatterns && value.indexOf(37) >= 0
        ? normalizePercentEscapesBytes(value)
        : value;
    const sortedCandidates = candidates
      .map((candidate) => ({
        ...candidate,
        index: (candidate.percentInsensitive ? normalizedValue : value).indexOf(
          candidate.needle,
        ),
      }))
      .sort(
        (left, right) =>
          right.needle.length - left.needle.length ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    const parts: Buffer[] = [];
    let offset = 0;
    while (true) {
      let next: (typeof sortedCandidates)[number] | undefined;
      for (const candidate of sortedCandidates) {
        if (candidate.index >= 0 && candidate.index < offset)
          candidate.index = (
            candidate.percentInsensitive ? normalizedValue : value
          ).indexOf(candidate.needle, offset);
        if (
          candidate.index >= 0 &&
          (next === undefined ||
            candidate.index < next.index ||
            (candidate.index === next.index &&
              candidate.needle.length > next.needle.length))
        )
          next = candidate;
      }
      if (next === undefined) break;
      parts.push(value.subarray(offset, next.index), next.marker);
      offset = next.index + next.needle.length;
    }
    if (parts.length === 0) return value;
    parts.push(value.subarray(offset));
    const redacted = Buffer.concat(parts);
    const normalizedRedacted =
      hasPercentPatterns && redacted.indexOf(37) >= 0
        ? normalizePercentEscapesBytes(redacted)
        : redacted;
    return containsSecretBytePattern(redacted, normalizedRedacted, candidates)
      ? Buffer.alloc(0)
      : redacted;
  }

  /** Remove only declared secret values from one URL and report that action. */
  sanitizeUrl(value: string): SanitizedBrowserUrl {
    const patterns = this.urlPatterns;
    if (patterns.length === 0) return sanitizeBrowserUrl(value);
    const output = replaceSecretLiterals(value, this.urlReplacements, patterns);
    if (
      containsSecretPattern(output, normalizePercentEscapes(output), patterns)
    )
      return {
        url: "",
        origin: null,
        query_parameter_names: [],
        redacted: true,
      };
    const sanitized = sanitizeBrowserUrl(output);
    return {
      ...sanitized,
      redacted: sanitized.redacted || output !== value,
    };
  }

  fingerprint(value: string): BrowserStorageValueFingerprint {
    const patterns = this.textPatterns;
    if (
      patterns.length > 0 &&
      containsSecretPattern(value, normalizePercentEscapes(value), patterns)
    )
      return { value_state: "redacted-secret", value_sha256: null };
    const hash = createHash("sha256");
    // In Unicode mode this class matches unpaired units, not valid pairs.
    if (!/[\uD800-\uDFFF]/u.test(value)) hash.update(value);
    // 0xff cannot occur in UTF-8, keeping the two preimage domains disjoint.
    else hash.update(Buffer.from([0xff])).update(value, "utf16le");
    return { value_state: "hashed", value_sha256: hash.digest("hex") };
  }
}
