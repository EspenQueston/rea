export const INSTALL_TIME_HOOKS: readonly string[];
export const PUBLIC_REGISTRY: string;

/** One configuration surface the invariants read. */
export interface ConfigurationSurface {
  readonly path: string;
  readonly kind: "script" | "shell" | "yaml";
}

export const CONFIGURATION_SURFACES: readonly ConfigurationSurface[];

/** One configuration document the invariants read. */
export interface ConfigurationDocument {
  readonly path: string;
  readonly text: string;
  readonly kind?: "script" | "shell" | "yaml";
}

export function findInstallTimeHooks(scripts: unknown): readonly string[];
export function findUndecidedInstallScripts(
  lockPackages: unknown,
  allowScripts: unknown,
): readonly string[];
export function findUnpinnedDirectDependencies(
  packageJson: unknown,
): readonly string[];
export function findUnresolvedLockEntries(
  lockPackages: unknown,
): readonly string[];
export function findDuplicateJsonKeys(
  documents: readonly ConfigurationDocument[],
): readonly string[];
export function stripComments(
  text: string,
  kind?: "script" | "shell" | "yaml",
): string;
export function findConfigurationViolations(
  documents: readonly ConfigurationDocument[],
): readonly string[];
