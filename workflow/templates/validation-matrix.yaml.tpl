version: 1
matrix:
  - name: scope-check
    when: every-slice
    intent: Confirm the proposed slice stays inside the declared writable scope.
    evidence: []
  - name: policy-check
    when: every-slice
    intent: Confirm protected surfaces and risk constraints were consulted.
    evidence: []
  - name: state-check
    when: before-closeout
    intent: Confirm the active session file matches the final slice outcome, including whether skipped validations were non-blocking or truly blocking.
    evidence: []
