# Active work

## HH-001 — first desktop version
State: independent implementation review
Owner: implementer; orchestrator integrates; requirements_review performs independent review.
Requirements: requirements.md
Architecture: architecture.md
Requirements evidence: reviews/HH-001-requirements.md
Branch: codex/hh-001-desktop
PR: https://github.com/anvictor/HostHarbor/pull/1
Checks: unit/local filesystem and queue tests, local protocol integration, Mac UI smoke. Exact commands follow implementation.
Next: independent review, resolve findings, PR/CI; merge only after required checks.
Validation: validation.md
Scope excludes file-content editing and folder synchronization permanently unless user changes requirements.
