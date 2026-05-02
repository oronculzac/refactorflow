# Closeout Prompt

You are closing out a completed workflow slice.

Use the current state and decision log as the source of truth.

Closeout inputs:
- state: `{{current_state}}`
- lane: `{{active_lane}}`
- validation result: `{{validation_result}}`

Closeout rules:
- Summarize what changed without expanding scope.
- Report whether validation passed and what evidence was used.
- Report skipped validations separately and say whether they were non-blocking
  external blockers or true blocking decisions.
- Record whether the hypothesis was `supported`, `refuted`, or `inconclusive`.
- Note any protected surface contact or exceptions explicitly.
- Append a decision log entry if a meaningful decision was made.
- If you record a follow-on candidate, mark it explicitly as open, closed,
  stale, or discarded instead of leaving rerank intent implicit.
- Keep one primary slice group staged at a time; treat workflow state and
  generated docs as allowed sidecars, not as a second feature slice.
- `scripts/workflow closeout` must include `--outcome <supported|refuted|inconclusive>`.
- If generated docs are stale, say to run `scripts/workflow refresh`; if
  generated docs were rewritten during commit prep, say to restage
  `workflow/state/generated/*` before retrying.
- Set the next state to `seeded` only if the slice is fully complete.

Output format:
- slice_id
- summary
- hypothesis check
- hypothesis outcome
- validation
- protected surface exceptions
- risks
- open questions
- next state
