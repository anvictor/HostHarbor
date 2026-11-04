# HostHarbor

A desktop file manager for hosting servers. macOS first, with portable protocol adapters for a future Windows build.

## Scope
Two local/remote panes, saved connections, SFTP / FTP / explicit FTPS, file and directory transfers, mkdir / rename / delete, and a cancellable transfer queue.

**No file-content editor. No folder synchronization.**

## Development
Requires Node.js 22.12 or newer. Install dependencies with `npm ci`, run checks with `npm test`, and start with `npm start`.
Project-local Node can be used when the system installation is older; no global Node changes are necessary.

Secrets are intended to be protected using the operating system via Electron safeStorage. SSH host keys require trust confirmation; changed keys are rejected. FTPS certificate validation remains enabled. Plain FTP is unencrypted and requires explicit confirmation.

## Project status
Under active development. Requirements are independently reviewed; local unit, protocol integration and Electron UI smoke tests passed; independent implementation review approved PR #1 and GitHub CI passed. Do not treat this as a production release.

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Active work](docs/tasks.md)
- [Requirements review](docs/reviews/HH-001-requirements.md)

Development uses disposable local test servers. No access to real hosting is needed for tests. Public release signing and notarization are outside the current development milestone.

Additional checks: `npm run check`, `npm run test:integration`, and `npm run test:ui` (requires a macOS desktop session). `npm run package:mac` creates an unsigned application for the current CPU architecture under `dist/`. Public distribution requires separate signing/notarization work.

UI smoke uses an isolated profile under `.tools/`, a disposable local fixture, and a loopback debugging port only during the test. Do not pass remote-debugging flags during normal use.
