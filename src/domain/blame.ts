import type { GitBlameLine } from "../git";
import type { LastReviewer, Reviewer, ReviewStatus } from "./types";

/**
 * Blame is only an initial classifier for genuinely new changed lines.
 *
 * Stored review metadata remains authoritative: an already-known record is
 * never reclassified from blame. These helpers decide the conservative
 * initial status for a new addition. Uncommitted working-tree lines and any
 * ambiguous attribution stay pending so unknown code is never silently
 * marked reviewed.
 */
export function isUncommittedBlameLine(blame: GitBlameLine): boolean {
  return /^0+$/.test(blame.commit);
}

function normalizedEmail(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

function normalizedName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}

/**
 * Compare a blame author against the current Git user.
 *
 * Returns true when the line belongs to the current user, false when it
 * confidently belongs to another user, and undefined when attribution is
 * ambiguous. Email is the primary identity; names are a conservative
 * fallback compared exactly after trimming.
 */
export function isCurrentUserLine(
  blame: GitBlameLine | undefined,
  currentUser: Reviewer | undefined,
): boolean | undefined {
  if (blame === undefined || currentUser === undefined) {
    return undefined;
  }
  if (isUncommittedBlameLine(blame)) {
    return true;
  }
  const blameEmail = normalizedEmail(blame.authorEmail);
  const currentEmail = normalizedEmail(currentUser.email);
  if (blameEmail !== undefined && currentEmail !== undefined) {
    return blameEmail === currentEmail;
  }
  const blameName = normalizedName(blame.authorName);
  const currentName = normalizedName(currentUser.name);
  if (blameName !== undefined && currentName !== undefined) {
    return blameName === currentName;
  }
  return undefined;
}

/**
 * Initial review status for a genuinely new added line.
 *
 * Only a confident other-user attribution becomes reviewed. The current
 * user, uncommitted lines, missing identity, and any ambiguity stay
 * pending.
 */
export function initialStatusForBlameLine(
  blame: GitBlameLine | undefined,
  currentUser: Reviewer | undefined,
): ReviewStatus {
  const current = isCurrentUserLine(blame, currentUser);
  if (current === false) {
    return "reviewed";
  }
  return "pending";
}

/**
 * Build the per-line initial-status callback expected by diff records.
 *
 * The returned callback performs only map lookups so rebuilding thousands
 * of lines does not spawn additional Git processes.
 */
export function initialStatusCallback(
  blame: ReadonlyMap<number, GitBlameLine>,
  currentUser: Reviewer | undefined,
): (currentLine: number) => ReviewStatus {
  return (currentLine: number) => {
    return initialStatusForBlameLine(blame.get(currentLine), currentUser);
  };
}

/**
 * Initial reviewer for a genuinely new added line classified as reviewed.
 *
 * Returns a reviewer derived from the blamed author only when the line is a
 * confident other-user addition (the same condition that yields a reviewed
 * status). All other lines return undefined because pending lines must not
 * carry a reviewer. The timestamp is supplied by the caller so every line in
 * one recomputation shares the same generation time.
 */
export function initialReviewerForBlameLine(
  blame: GitBlameLine | undefined,
  currentUser: Reviewer | undefined,
  at: string,
): LastReviewer | undefined {
  if (initialStatusForBlameLine(blame, currentUser) !== "reviewed") {
    return undefined;
  }
  const name = normalizedName(blame?.authorName) ?? normalizedName(currentUser?.name);
  if (name === undefined) {
    return undefined;
  }
  const email = normalizedEmail(blame?.authorEmail) ?? normalizedEmail(currentUser?.email);
  return email === undefined ? { name, time: at } : { name, email, time: at };
}

/**
 * Build the per-line initial-reviewer callback expected by diff records.
 *
 * Like the status callback, this performs only map lookups. It must be
 * passed together with `initialStatusCallback` so blame-derived reviewed
 * lines persist with a reviewer and satisfy v4 validation on restart.
 */
export function initialReviewerCallback(
  blame: ReadonlyMap<number, GitBlameLine>,
  currentUser: Reviewer | undefined,
  at: string,
): (currentLine: number) => LastReviewer | undefined {
  return (currentLine: number) => {
    return initialReviewerForBlameLine(blame.get(currentLine), currentUser, at);
  };
}
