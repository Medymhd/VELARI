# Contributing

Thanks for your interest in contributing. This project is currently proprietary (all rights reserved) — the guidelines below define exactly how contributions are accepted.

## Ground rules

1. **By opening a pull request you grant the project owners a perpetual, worldwide, royalty-free right to use, modify, sublicense, and distribute your contribution** as part of the project under any license the owners choose. If you cannot accept this, do not open a PR.
2. Sign off every commit (`git commit -s`) — this certifies the [Developer Certificate of Origin](https://developercertificate.org/): you have the right to submit the code you are contributing.
3. Code must pass the full gate: `pnpm build` (18/18 turbo tasks), `pnpm test`, and `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` (24/24).

## Local development

- Postgres runs on port **5433** via the tests-override compose (see README Getting Started).
- Prisma commands must run from `apps/api` via the local `.bin` binary.
- `pnpm dev:api` auto-loads `.env` — no manual env export needed.
- Integration tests (security, RAG) **skip cleanly** when Postgres is unreachable.

## Code standards

- **Brand-neutral**: no product names in source, identifiers, event names, or comments — identity lives only in the brand package (see `docs/adr/0002`).
- **No watermarks**: no authorship markers, AI-generation notes, or vanity tags.
- Strict typing everywhere; errors handled, never swallowed; no dead code; comments only for non-obvious rationale.
- Tests ship with the code they change (TS: `node --test` per package; Rust: `cargo test`).
- Security-sensitive areas (`apps/desktop/src-tauri/src/stealth.rs`, `keyboard.rs`, `keybind.rs`, auth, secrets) require maintainer review — do not merge changes there without an explicit approval from a maintainer.

## Process

1. Fork (or branch from `main`): `feat/<short-name>` or `fix/<short-name>`.
2. Small, focused PRs — one logical change per PR.
3. Conventional commit messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
4. The CI pipeline must be green (build + TS suites + Rust).
5. A maintainer reviews and merges. Squash-merge only.

## Reporting bugs

Open an issue with the bug template: repro steps, expected vs actual, environment. For security issues use the private channel in `SECURITY.md` — never a public issue.
