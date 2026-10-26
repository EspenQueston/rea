/**
 * Legality of local-variable names and field descriptors, as HotSpot checks
 * them when it loads a class (`ClassFileParser::verify_legal_field_name` and
 * `verify_legal_field_signature`, JVMS §4.2.2 and §4.3.2).
 *
 * From class version 49 (Java 5) names are unqualified names: any code point
 * except `.`, `;`, `[` and `/` (a class name in a descriptor may also contain
 * `/` between non-empty segments). Older classes use Java identifier rules.
 * Those are checked exactly for ASCII; a non-ASCII character is accepted
 * there, because HotSpot decides it with `Character.isJavaIdentifierPart`,
 * which this reader does not reproduce.
 */

/**
 * Class version 49 (Java 5, HotSpot `JAVA_1_5_VERSION`): HotSpot applies the
 * JSR 202 unqualified-name rules and parses LocalVariableTypeTable from here.
 */
export const JAVA_5_MAJOR_VERSION = 49;

/** JVMS §4.3.2: an array type has at most 255 dimensions. */
const MAX_ARRAY_DIMENSIONS = 255;

const PRIMITIVE_FIELD_TYPES = new Set(["B", "C", "D", "F", "I", "J", "S", "Z"]);

/** JVMS §4.2.2 unqualified name; `/` is legal only between segments of a class name. */
const isUnqualifiedName = (name: string, className: boolean): boolean => {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i]!;
    if (ch === "." || ch === ";" || ch === "[") return false;
    if (ch === "/") {
      if (!className || i === 0 || i === name.length - 1) return false;
      if (name[i + 1] === "/") return false;
    }
  }
  return true;
};

const isAsciiLetter = (ch: string): boolean =>
  (ch >= "a" && ch <= "z") ||
  (ch >= "A" && ch <= "Z") ||
  ch === "_" ||
  ch === "$";

/**
 * Pre-49 identifier rule (`skip_over_field_name`): ASCII letters, `_`, `$`,
 * and digits after the first character; a class name may also hold `/`, but
 * never two in a row. HotSpot accepts a leading `/`, and a trailing one
 * before the descriptor's `;`, so those stay legal here too.
 */
const isLegacyIdentifier = (name: string, className: boolean): boolean => {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i]!;
    if (ch.charCodeAt(0) >= 0x80 || isAsciiLetter(ch)) continue;
    if (i > 0 && ch >= "0" && ch <= "9") continue;
    if (className && ch === "/" && name[i - 1] !== "/") continue;
    return false;
  }
  return true;
};

/** Whether HotSpot accepts `name` as a field or local-variable name in a class of `majorVersion`. */
export const isLegalFieldName = (
  name: string,
  majorVersion: number,
): boolean =>
  majorVersion >= JAVA_5_MAJOR_VERSION
    ? isUnqualifiedName(name, false)
    : isLegacyIdentifier(name, false);

/** Whether HotSpot accepts `descriptor` as a field descriptor (JVMS §4.3.2) in a class of `majorVersion`. */
export const isLegalFieldDescriptor = (
  descriptor: string,
  majorVersion: number,
): boolean => {
  let at = 0;
  while (descriptor[at] === "[") at += 1;
  if (at > MAX_ARRAY_DIMENSIONS) return false;
  const tag = descriptor[at];
  if (tag !== undefined && PRIMITIVE_FIELD_TYPES.has(tag))
    return at + 1 === descriptor.length;
  if (tag !== "L") return false;
  const end = descriptor.indexOf(";", at + 1);
  if (end !== descriptor.length - 1) return false;
  const className = descriptor.slice(at + 1, end);
  return majorVersion >= JAVA_5_MAJOR_VERSION
    ? isUnqualifiedName(className, true)
    : isLegacyIdentifier(className, true);
};
