# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via GitHub's "Report a vulnerability" button on the Security tab, or email the maintainers directly. Include: affected component, repro steps or PoC, impact assessment, and any suggested mitigation.

You will receive an acknowledgment within 72 hours. Coordinated disclosure: we ask for up to 90 days before public disclosure; we will credit reporters in release notes unless anonymity is requested.

## Scope

In scope:
- Auth/session handling, token minting/verification (platform JWT + STT relay HMAC)
- Tenant/workspace isolation (any cross-workspace data access)
- Secret handling (BYOK sealing, vault, redaction) and key-material exposure
- The realtime WebSocket pipeline (injection, replay, DoS via malformed frames)
- Browser extension isolation (world leakage, guard fingerprinting)
- Desktop stealth layer behaviors (this is a declared red-team exercise — see `docs/red-team/handoff-brief.md` for the intended detection surface)

Out of scope:
- Vulnerabilities in third-party services (report to the vendor)
- Social engineering of users
- Issues requiring physical access to an unlocked machine

## Hard rules for contributors

- Never commit secrets, keys, tokens, or credential material — `.env` and `apps/desktop/keys/updater.key` are gitignored for this reason.
- Never log secrets, transcripts, or user content — redaction is enforced by the observability package; content logging is consent-gated by default.
- Any change to auth, secrets, or tenant boundaries requires maintainer review and updated tests in `apps/api/src/security.test.ts`.
