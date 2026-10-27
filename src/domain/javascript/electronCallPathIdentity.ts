import type { ElectronCallPath } from "./electronStaticAnalysisTypes.js";
import { sha256Text } from "./javascriptStaticAnalysisHelpers.js";

/** One source-occurrence identity shared by application and semantic projections. */
export const electronCallPathId = (
  sourcePath: string,
  path: ElectronCallPath,
): string => sha256Text(JSON.stringify([sourcePath, path]));
