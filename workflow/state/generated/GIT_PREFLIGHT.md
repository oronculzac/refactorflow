# Git Preflight

- refreshed at: `not recorded`

## Working Tree

```text
branch: main
exact working tree output omitted from generated docs; run `git status --short --branch` locally
```

## Continue Safely

- keep one writable scope at a time
- stage the active slice first; let workflow state and generated docs ride along as sidecars
- keep the structured workflow state authoritative
- use `scripts/workflow precommit --strict --json` before commit when you want hard enforcement
- refresh generated docs after changing workflow state
- if refresh or formatters rewrite generated docs, restage `workflow/state/generated/*` before retrying commit
- current scope: not yet recorded
- current hypothesis: not yet recorded
