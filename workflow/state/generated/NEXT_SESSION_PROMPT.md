# Next Session Prompt

Read the workflow state in this order:

- `workflow/manifest.yaml`
- `workflow/state/active-session.yaml`
- `workflow/policy/protected-surfaces.yaml`
- `workflow/policy/validation-matrix.yaml`
- `workflow/policy/risk-map.yaml`
- `workflow/policy/runtime-hubs.yaml`
- `workflow/lanes/core-import-cleanup.yaml`

Then run:

```text
scripts/workflow bootstrap --json
```

Current state: `seeded`
Active lane: `core-import-cleanup`
Active slice ID: `not yet recorded`
Active hypothesis: not yet recorded
Hypothesis check: not yet recorded
Hypothesis outcome: not yet recorded
Suggested next command: `begin-slice`
Reason: No active hypothesis is recorded yet.
