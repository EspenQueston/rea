/** A package pattern key contains exactly one star. */
export const isSingleStarPatternKey = (key: string): boolean =>
  key.includes("*") && key.indexOf("*") === key.lastIndexOf("*");

/** Node package patterns contain one star matching at least one character. */
export const packageSubpathPatternMatches = (
  pattern: string,
  subpath: string,
): boolean => {
  const wildcard = pattern.indexOf("*");
  return (
    isSingleStarPatternKey(pattern) &&
    subpath.length >= pattern.length &&
    subpath.startsWith(pattern.slice(0, wildcard)) &&
    subpath.endsWith(pattern.slice(wildcard + 1))
  );
};

/** Node chooses the longest prefix, then the longest complete pattern key. */
export const selectPackageSubpathPattern = (
  patterns: readonly string[],
  subpath: string,
): { readonly key: string; readonly capture: string } | null => {
  let selected: string | undefined;
  for (const pattern of patterns) {
    if (!packageSubpathPatternMatches(pattern, subpath)) continue;
    if (
      selected === undefined ||
      pattern.indexOf("*") > selected.indexOf("*") ||
      (pattern.indexOf("*") === selected.indexOf("*") &&
        pattern.length > selected.length)
    )
      selected = pattern;
  }
  if (selected === undefined) return null;
  const wildcard = selected.indexOf("*");
  return {
    key: selected,
    capture: subpath.slice(
      wildcard,
      subpath.length - (selected.length - wildcard - 1),
    ),
  };
};
