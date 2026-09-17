# Tech Debt

## Pure-deletion attribution

Current-file `git blame` cannot attribute deleted lines because they have no
current-file side to blame. Blaming the previous version would only show the
original author, not who deleted the lines, so it cannot answer the review
question.

Therefore pure deletions conservatively start `pending` for now. Replacement
deletions in an unambiguous 1-1 hunk may inherit the added side's initial
classification; larger hunks stay conservative `pending`. A future change may
investigate history analysis for deleted-line authorship.

This is intentionally deferred to preserve the snapshot-authoritative
architecture: the snapshot diff determines what changed and stored metadata
determines known-line status. Blame remains only an initial classifier for
newly discovered current-line additions.
