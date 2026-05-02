# Gem-Cli RefactorFlow Pack

This pack is a template for running RefactorFlow in `gem-cli` without changing
the `gem-cli` repository from this kit repo.

## Activation

The RefactorFlow installer copies this pack into target repositories as part of
`workflow/`. Use `--pack gem-cli` to activate the pack while installing:

```text
./scripts/install-workflow-kit --target /path/to/gem-cli --pack gem-cli
```

Activation merges the pack's protected surfaces, validation matrix, runtime-hub
rules, and context hygiene budgets into the target repo's active workflow
policy. Start slices with narrow writable scope and run the validation commands
selected by this pack.

Keep the pack as the policy source for `gem-cli`-specific workflow defaults.
Do not copy large historical notes from `gem-cli`; link or summarize them in
handoff records instead.

## Files

- `pack.yaml`: pack index and usage notes.
- `protected-surfaces.yaml`: read-only surfaces for bounded refactor work.
- `validation-matrix.yaml`: validation commands derived from the harness config.
- `runtime-hub-rules.yaml`: stricter runtime-owned export rules.
- `context-hygiene.yaml`: active prompt and generated-doc compactness rules.
