import { File, Paths } from 'expo-file-system';
import { EMPTY_REVIEW_STATE, parseReviewState, type ReviewState } from './review-flow';

/**
 * What the Review tab keeps on this phone, outside the vault (ADR 0095): the
 * Yes records, "Not now" until midnight, and the last read's item ids. Ids,
 * kinds and times only, never memory text, so a plain file in the app's
 * documents directory is enough. Not in SecureStore: the list grows, and a
 * keychain item is the wrong place for it.
 *
 * NEEDS ON-DEVICE VALIDATION: the File API is not run from this environment.
 */

const REVIEW_STATE_FILENAME = 'review-state.json';

function stateFile(): File {
  return new File(Paths.document, REVIEW_STATE_FILENAME);
}

export async function loadReviewState(): Promise<ReviewState> {
  try {
    const file = stateFile();
    return file.exists ? parseReviewState(file.textSync()) : EMPTY_REVIEW_STATE;
  } catch {
    // A file that cannot be read starts the list empty; it never blocks the screen.
    return EMPTY_REVIEW_STATE;
  }
}

export async function saveReviewState(state: ReviewState): Promise<void> {
  const file = stateFile();
  if (!file.exists) file.create();
  file.write(JSON.stringify(state));
}

/** Sign-out and wipe: the records name memories of a vault this phone no longer holds. */
export async function clearReviewState(): Promise<void> {
  try {
    const file = stateFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing to clear.
  }
}
