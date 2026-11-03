# HH-001 — HostHarbor v0.1 requirements
Status: awaiting independent requirements review. User authorized implementation.

## Original agreed product scope
Desktop Mac application; future Windows support should remain possible. Provider-independent remote file manager using SFTP, FTP and explicit FTPS. Multiple saved connections. Local and remote panels. Upload/download files and directories; create directories, rename, delete. Sequential transfer queue with progress and cancellation, understandable errors. Passwords stored with OS-backed protection; SSH private keys supported.
File-content editing and folder synchronization are permanently excluded unless the user explicitly changes product requirements. No S3 in v0.1.

## Safety acceptance criteria
- Only local trusted renderer code, no Node integration; narrow validated IPC, no remote executable content.
- SFTP first-use fingerprint requires explicit native confirmation before authentication; changed keys blocked. FTPS validates certificates, no insecure fallback. Plain FTP requires an explicit warning/confirmation.
- Passwords/passphrases never in plaintext persistent files or logs. Key files selected by native dialog and read in main process. Secret-store failure blocks remembering secrets, not silently falling back to plaintext.
- Delete requires explicit confirmation; root deletion forbidden; no recursive symlink following. Single-component names validated. Untrusted server listings cannot escape destination directories.
- Copies never silently replace files: confirmation or skip/error. Stage file transfers where feasible; cancellation/errors must not leave a truncated destination presented as successful. Directory transfers can partially complete and report that accurately.
- Queue entries bind a connection/session and source/destination paths; changing connection cannot redirect queued work. Prevent conflicting operations while active transfers run; cancellation closes active transport, pending jobs never auto-replay.
- Transfer and connection failures leave usable UI, no secret values in errors. Progress is byte-based where available; no fabricated completion.

## Acceptance and checks
Run automated local filesystem, path-validation, queue/cancellation and credential-persistence tests. Exercise SFTP/FTP/FTPS against local disposable servers where feasible. Smoke-test desktop UI and saved connection restart. Report untested macOS Keychain/UI/protocol behaviors honestly; do not claim production readiness.

## Scope and authority
User approved project-local dependencies, local tests, commits, push and PR creation. Merge only after independent review plus passing checks. System-wide installs, paid actions and changes to real hosting require separate approval. No real hosting credentials needed for development.
Do not publish local personal paths or CV artifacts to public GitHub. AGENTS.md and CV_EXPERIENCE_CHECKPOINT.md remain local. Public docs use portable paths.

## Delivery milestones
1. Requirements, architecture, repository and checks (10%).
2. Desktop shell, local files and saved connections (20%).
3. SFTP/FTP/FTPS adapters and trusted connections (25%).
4. File operations, recursive transfers and queue (25%).
5. Integration tests, independent review, Mac smoke/package (20%).
Percentages estimate delivered, verified behavior, not lines of code.

## Resolved v0.1 defaults
Explicit FTPS only (TLS upgrade); implicit FTPS excluded from v0.1. No resume, automatic retry or persistent queue. Queue lives for current app session; closing during pending work requires confirmation. Symlinks are displayed but not traversed/transferred/deleted recursively; skipped entries reported. Directory deletion requires native confirmation listing target and recursive impact. File overwrite requires native per-file confirmation; declining skips and reports. File staging followed by rename preferred; replacement atomicity depends on server and must not be promised universally. macOS minimum follows installed Electron support; both Apple Silicon and Intel intended, only current machine executable tested initially.
