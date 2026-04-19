# RefactorFlow Guide

This is the human-readable companion to RefactorFlow's structured workflow
state. The authoritative source of truth lives under `workflow/`.

RefactorFlow is optimized for bounded, reviewable refactor slices and is meant
to be legible to both humans and coding agents. Use this file for the operating
model, and use the YAML files for the binding contract.

## Start Here

1. Read `workflow/manifest.yaml`.
2. Run `scripts/workflow bootstrap --json`.
3. Continue only the lane and next step returned by bootstrap and status.

## Canonical Reading Order

1. `workflow/manifest.yaml`
2. `workflow/state/active-session.yaml`
3. `workflow/policy/protected-surfaces.yaml`
4. `workflow/policy/validation-matrix.yaml`
5. `workflow/policy/risk-map.yaml`
6. `workflow/policy/runtime-hubs.yaml`
7. `workflow/lanes/core-import-cleanup.yaml`

## Canonical Command Surface

- `./scripts/install-workflow-kit --target <repo>`
- `scripts/workflow help --json`
- `scripts/workflow bootstrap --json`
- `scripts/workflow status --json`
- `scripts/workflow begin-slice --scope <path> --hypothesis <text> --json`
- `scripts/workflow validate --kind <kind> --command <cmd> --json`
- `scripts/workflow record-pass --command <cmd> --json`
- `scripts/workflow record-skip --command <cmd> --reason <text> [--blocking] --json`
- `scripts/workflow record-candidate --candidate <text> --status <open|closed|stale|discarded> --reason <text> --json`
- `scripts/workflow suggest-next --json`
- `scripts/workflow refresh --json`
- `scripts/workflow closeout --json`
- `scripts/workflow precommit --json`

## Precommit Semantics

- `precommit` inspects staged files first. If nothing is staged, it falls back to
  the dirty working tree.
- Keep one primary slice group staged at a time.
- Allow workflow sidecars to ride along:
  - `workflow/state/active-session.yaml`
  - `workflow/state/decision-log.ndjson`
  - generated docs under `workflow/state/generated/`
- If generated docs are stale, run `scripts/workflow refresh`.
- If `refresh` or a formatter rewrites generated docs during commit prep,
  restage `workflow/state/generated/*` before retrying.
- If primary files do not share one path family, split them into separate slice
  commits instead of forcing them through one closeout.

## State Model

- `seeded`: the kit is loaded, but no active slice has been chosen.
- `bootstrapping`: manifest and policy are being loaded.
- `scoping`: the slice is being narrowed to one hypothesis and one scope.
- `implementing`: files are being changed inside the allowed scope.
- `validating`: checks are being run and recorded.
- `closeout`: the slice is being summarized and logged.
- `blocked`: the workflow needs a new decision before continuing because a
  blocking validation skip or other explicit stop was recorded.

## Skip Semantics

- `record-skip` is non-blocking by default. Use it for unrelated or external
  validation blockers that should be documented but should not stop the slice.
- Add `--blocking` only when the skip should halt the workflow.
- Non-blocking skips are recorded in session state as external blockers and
  should be reported explicitly at closeout.
- Blocking skips set `blocked_reason` and keep `suggest-next` in a stop-and-decide
  path.

## Candidate Hygiene

- Use `record-candidate` to keep one latest candidate record plus an append-only
  candidate log.
- `open` means the candidate is still a valid next slice.
- `closed`, `stale`, and `discarded` all mean the kit should tell the next turn
  to rerank fresh before opening work.
- Keep candidate status lightweight: latest status wins, and document the reason
  instead of building a planner.

## Operating Principles

- make one hypothesis per slice
- keep writable scope narrow
- keep YAML authoritative and Markdown generated
- protect read-only surfaces by default
- record decisions explicitly instead of implying them in prose
