# Changelog

All notable changes to RefactorFlow will be documented in this file.

## Unreleased

- Added strict `precommit --strict` enforcement with non-zero exits for
  checklist failures.
- Added protected-surface exception recording and automatic blocking on
  unapproved protected-surface touches during precommit.
- Added required `closeout --outcome <supported|refuted|inconclusive>` support
  plus hypothesis outcome tracking in session state.
- Added session lock handling through `workflow/state/.session.lock` and stale
  lock recovery with `scripts/workflow unlock --force`.
- Added integration tests for strict precommit, protected-surface blocking,
  closeout outcome enforcement, and stale-lock recovery.

## v0.1.0

Initial public release.

- Added the YAML-first RefactorFlow workflow kit and JSON-first CLI.
- Added installer support for copying the workflow kit into another repository.
- Added generated workflow sidecars for current slice, next session prompt, and
  git preflight.
- Added repository health files, issue forms, PR template, and CI.
- Added explicit AI assistance and OpenAI Codex disclosure guidance.
