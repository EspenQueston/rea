import { isAbsolute, join, posix, win32 } from "node:path";

/** Per-user cache directory that REA owns for Kuna on this host. */
export const defaultKunaCacheDirectory = (
  home: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string => {
  if (platform === "darwin")
    return join(home, "Library", "Caches", "rea", "kuna");
  const xdg = environment.XDG_CACHE_HOME;
  return join(
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".cache"),
    "rea",
    "kuna",
  );
};

/**
 * Lexical directory identity. Does not follow symbolic links.
 * On Darwin and Linux, `\` is a filename character, so only `/` is removed.
 */
export const sameLexicalDirectory = (
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean =>
  lexicalDirectory(left, platform) === lexicalDirectory(right, platform);

const lexicalDirectory = (
  value: string,
  platform: NodeJS.Platform,
): string => {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi.normalize(value);
  const root = pathApi.parse(normalized).root;
  let end = normalized.length;
  while (
    end > root.length &&
    normalized.charCodeAt(end - 1) === pathApi.sep.charCodeAt(0)
  )
    end -= 1;
  return normalized.slice(0, end);
};
