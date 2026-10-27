import type { ElectronCallPath } from "./electronStaticAnalysisTypes.js";
import { sha256Text } from "./javascriptStaticAnalysisHelpers.js";

/**
 * Identity of one discovered Electron call path instance.
 *
 * A path is only meaningful inside the module that produced it, so the owning
 * module path is part of the identity: identical wrapper chains in two files
 * remain distinct candidates. Semantic and application projections must use
 * this helper rather than hash their own representation, or the two graphs
 * stop correlating on `path_id`.
 */
export const electronCallPathId = (
  modulePath: string,
  path: ElectronCallPath,
): string => sha256Text(JSON.stringify([modulePath, path]));
