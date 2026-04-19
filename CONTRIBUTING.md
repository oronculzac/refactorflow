# Contributing to RefactorFlow

RefactorFlow is an AI-assisted workflow kit for small, reviewable refactor slices.
Contributions are welcome, but this repository is maintained by a solo maintainer,
so clear scope and low review overhead matter.

## Before You Start

- Open an issue before large changes, new workflow lanes, or behavior changes.
- Keep one concern per pull request.
- Prefer extending the existing workflow contract over adding parallel patterns.

## What Good Changes Look Like

- Small, bounded diffs with a clear reason for the change.
- Updates that keep `workflow/` as the source of truth.
- Documentation changes that match actual command or workflow behavior.
- Validation notes that explain what was checked and what was intentionally skipped.

## Pull Request Expectations

- Describe the problem, the approach, and any tradeoffs.
- Call out user-visible behavior changes.
- Keep generated or derived changes tightly related to the main diff.
- Do not mix unrelated cleanup into the same PR.

## AI-Assisted Contributions

AI assistance is allowed, including OpenAI Codex, but you remain responsible for
the submitted work.

- Review and understand every generated change before submitting it.
- Verify commands, tests, and documentation claims yourself.
- Disclose material AI assistance in the PR description.

Example disclosure:

`Drafted with OpenAI Codex; reviewed, edited, and validated by the contributor.`

For repository-wide expectations, see `AI_POLICY.md`.

## Review Model

The maintainer may decline changes that are useful in isolation but increase the
long-term maintenance burden, broaden scope, or dilute the bounded-refactor focus.
