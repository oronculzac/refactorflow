# Bootstrap Prompt

You are bootstrapping a refactor slice from a portable workflow kit.

Read these files in order:
1. `workflow/manifest.yaml`
2. `workflow/state/active-session.yaml`
3. `workflow/policy/protected-surfaces.yaml`
4. `workflow/policy/validation-matrix.yaml`
5. `workflow/policy/risk-map.yaml`
6. `workflow/policy/runtime-hubs.yaml`
7. `workflow/lanes/core-import-cleanup.yaml`

Current state: `{{current_state}}`
Active lane: `{{active_lane}}`

Bootstrap rules:
- State the one small hypothesis you will test.
- If possible, state the concrete check that will decide whether the hypothesis was supported, refuted, or inconclusive.
- Declare the writable scope before editing anything.
- Refuse to touch protected surfaces unless an explicit exception exists.
- If a protected surface must change, record it explicitly with `scripts/workflow record-protected-surface --surface <path> --reason <text>`.
- Select validation checks from `workflow/policy/validation-matrix.yaml`.
- Record decisions in `workflow/state/decision-log.ndjson`.
- If the last recorded candidate is stale, closed, or discarded, rerank fresh
  before opening the next slice.

Output format:
- current state
- lane
- writable scope
- hypothesis check
- selected checks
- next action
