# Runtime Hub Prompt

You are working on a runtime-owned export surface.

Target hub: `{{hub_name}}`
Location hint: `{{location_hint}}`

Required order:
1. Inspect the runtime hub map.
2. Generate the current import map.
3. Define discard criteria before editing.
4. Run fast build plus circular checks before broad validation.

Do not proceed if:
- circular imports increase
- new dependencies flow through `config.ts` or `index.ts`
- the slice expands into auth, policy, sandbox, trust, or MCP behavior

Record the chosen discard criteria and the validation evidence before any closeout.

