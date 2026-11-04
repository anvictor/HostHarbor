# Active work

## HH-001 — first desktop version
State: merged; local macOS v0.1 ready
Owner: implementer; orchestrator integrates; requirements_review performs independent review.
Requirements: requirements.md
Architecture: architecture.md
Requirements evidence: reviews/HH-001-requirements.md
Branch: codex/hh-001-desktop
PR: https://github.com/anvictor/HostHarbor/pull/1
Checks: unit/local filesystem and queue tests, local protocol integration, Mac UI smoke. Exact commands follow implementation.
Merged via PR #1 after independent APPROVE and both successful CI jobs.
Reviewed implementation: fccb7ef319a092fe6cbbb6dac6cb56bd31aa0150
Merge commit: a3f8be9a333ecd221738560c07d233b511eaff61
Review: https://github.com/anvictor/HostHarbor/pull/1#issuecomment-6625983645
Next: user acceptance on a real hosting connection, under separate authorization for remote changes.
Validation: validation.md
Scope excludes file-content editing and folder synchronization permanently unless user changes requirements.
