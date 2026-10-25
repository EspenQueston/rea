import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  buildDexPartialObservation,
  type DexSummaryMember,
} from "../domain/dex/dexDebugMetadataReport.js";

/**
 * The summaries completed so far in one call, and the member being analysed.
 * When the call then fails (a later member refused, a cancellation, a failed
 * read), the completed summaries are retained on that failure. A class detail
 * retains nothing: a match is only an answer once every member was checked.
 */
export class DexProgress {
  completed: readonly DexSummaryMember[] = [];
  unfinished: { entry: string | null; unread_members: number } | null = null;

  retainOn(error: AnalysisError, path: string): AnalysisError {
    if (this.completed.length > 0)
      error.retainPartialObservation(
        buildDexPartialObservation(path, this.completed, this.unfinished),
      );
    return error;
  }
}
