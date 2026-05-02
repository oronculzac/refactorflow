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
- `scripts/workflow validate --kind <kind> --command <cmd> [--run] --json`
- `scripts/workflow record-pass --command <cmd> --json`
- `scripts/workflow record-skip --command <cmd> --reason <text> [--blocking] --json`
- `scripts/workflow record-candidate --candidate <text> --status <open|closed|stale|discarded> --reason <text> --json`
- `scripts/workflow record-protected-surface --surface <path> --reason <text> --json`
- `scripts/workflow suggest-next --json`
- `scripts/workflow refresh --json`
- `scripts/workflow closeout --outcome <supported|refuted|inconclusive> --json`
- `scripts/workflow precommit [--strict] --json`
- `scripts/workflow unlock --force --json`

## Precommit Semantics

- `begin-slice` inspects the dirty working tree before opening a new slice. If
  dirty files already exist, they must be inside the declared writable scope;
  workflow sidecars may ride along.
- `precommit` inspects staged files first. If nothing is staged, it falls back to
  the dirty working tree.
- Keep one primary slice group staged at a time.
- Allow workflow sidecars to ride along:
  - `workflow/state/active-session.yaml`
  - `workflow/state/decision-log.ndjson`
  - generated docs under `workflow/state/generated/`
- If generated docs are stale, run `scripts/workflow refresh`.
- Generated docs are also checked against the line budgets configured in
  `workflow/manifest.yaml`.
- If `refresh` or a formatter rewrites generated docs during commit prep,
  restage `workflow/state/generated/*` before retrying.
- If primary files do not share one path family, split them into separate slice
  commits instead of forcing them through one closeout.
- `precommit --strict` exits non-zero when required checklist items fail.
- Touching a protected surface without a recorded exception auto-blocks the
  session and requires a new decision before closeout.

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

## Validation Execution

- `validate --kind <kind> --command <cmd>` records validation intent without
  executing the command.
- Add `--run` to execute the command from the repository root without a shell.
- Validation kinds must match `validation_kinds` in `workflow/manifest.yaml`.
- Successful executed validation is pass-like and can make closeout ready;
  failed executed validation blocks closeout until a passing result is recorded.

## Candidate Hygiene

- Use `record-candidate` to keep one latest candidate record plus an append-only
  candidate log.
- `open` means the candidate is still a valid next slice.
- `closed`, `stale`, and `discarded` all mean the kit should tell the next turn
  to rerank fresh before opening work.
- Keep candidate status lightweight: latest status wins, and document the reason
  instead of building a planner.

## Protected Surface Exceptions

- Protected surfaces stay read-only unless the slice records an explicit
  exception.
- Protected surface entries may be exact paths or directory-style prefixes such
  as `path/to/dir/`, `path/to/dir/*`, or `path/to/dir/**`.
- Use `record-protected-surface` before staging a protected surface change.
- Workflow-owned sidecars such as `workflow/state/active-session.yaml` and
  `workflow/state/decision-log.ndjson` remain allowed without extra exceptions.

## Closeout Outcome

- `closeout` now requires `--outcome <supported|refuted|inconclusive>`.
- Do not close a slice until a pass-like validation result is recorded.
- Treat `supported`, `refuted`, and `inconclusive` as hypothesis outcomes, not
  as commit quality labels.

## Session Locking

- Mutating workflow commands acquire `workflow/state/.session.lock`.
- If a stale lock remains after an interrupted command, clear it with
  `scripts/workflow unlock --force`.
- Prefer unlocking only after confirming no other agent is still mutating the
  workflow state.

## Workflow Packs

- Target-specific packs live under `workflow/packs/`.
- `workflow/packs/gem-cli/` is a `gem-cli` policy pack. Install with
  `scripts/install-workflow-kit --target <repo> --pack gem-cli` to activate it
  in the target workflow policy.

## Operating Principles

- make one hypothesis per slice
- keep writable scope narrow
- keep YAML authoritative and Markdown generated
- protect read-only surfaces by default
- record decisions explicitly instead of implying them in prose
