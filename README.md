# App — Modular AI Agent Platform

First vertical: **Interview Intelligence** — dual-channel live transcription (you + interviewer), streaming STT, coaching frameworks with vector recall, post-session review, and a capture-excluded stealth overlay. Built as a make-then-break exercise with a red team that tries to detect and break stealth features.

Brand is configured in one place: `packages/brand/src/index.ts`. Change the values there to rebrand the entire workspace.

## Architecture

See `VELARI ARCHITECTURE.md` for the full platform spec. Quick view:

- `apps/desktop` — Tauri 2 + React shell: native dual-channel audio (CPAL mic + WASAPI loopback), stealth layer, capture-excluded overlay, cropper
- `apps/web` — companion admin console (same API)
- `apps/api` — Fastify + Prisma (Postgres + pgvector), WebSocket realtime (per-channel STT, judged coaching), STT relay, vision/OCR route, vector recall
- `apps/worker` — BullMQ retention and post-session summaries (Redis)
- `packages/audio-runtime` — STT engine chain: Deepgram streaming (paid) → Moonshine-tiny local (free, MIT) → sherpa Zipformer → Deepgram REST → local Whisper server → simulated
- `packages/ai-runtime` — provider router + circuit breakers, embeddings, vision, image/OCR
- `packages/contracts` / `domain` / `security` / `observability` / `ui` / `brand` — shared design system and contracts
- `verticals/interview-intelligence` — manifest, coach prompts, auto-answer judge
- `benchmarks/` — gateway, STT, vision, load, and rival-parity harnesses
- `infra/docker/` — Postgres (pgvector) / Redis / MinIO

**Free-and-open operating mode:** everything runs end-to-end at $0 (local Moonshine/lexicon models, free cloud tiers Groq + b.ai + OpenRouter `:free`, simulated fallbacks). Paid providers are optional rungs behind the same contracts.

## Getting started

Prerequisites: Node ≥ 22, pnpm 10 (`corepack enable`), Rust toolchain (for the desktop shell), Docker Desktop, Windows 10/11 for native audio + stealth (macOS/Linux compile with degraded features).

### 1. Environment

```sh
cp .env.example .env
```
Set at minimum: `DATABASE_URL`, `JWT_SECRET`, `SECRET_MASTER_KEY`. Optional keys unlock cloud rungs: `DEEPGRAM_API_KEY` (streaming partials), `GROQ_API_KEY` / `BAI_API_KEY` (managed LLM routing), `OPENROUTER_*` / `OPENAI_COMPAT_*` (benchmarks). Unset = the free stack is used automatically.

### 2. Database

Port note: `infra/docker/docker-compose.tests.yml` maps Postgres to **5433** so the stack never fights another local Postgres on 5432. `.env` ships with `DATABASE_URL=…localhost:5433/app` to match.

PowerShell:
```powershell
docker compose -p velari-tests `
  -f infra/docker/docker-compose.yml `
  -f infra/docker/docker-compose.tests.yml up -d postgres

Set-Location apps\api
.\node_modules\.bin\prisma.cmd db push --skip-generate
Set-Location ..\..
```

bash:
```sh
docker compose -p velari-tests \
  -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.tests.yml up -d postgres
export DATABASE_URL="postgresql://app:app@localhost:5433/app"
(cd apps/api && ./node_modules/.bin/prisma db push --skip-generate)
```

The pgvector extension is created automatically (the compose image is `pgvector/pgvector:pg16`). Prisma note: raw SQL params arrive as TEXT — do not use `::uuid` casts against them.

### 3. Install & run

```sh
pnpm install
pnpm build        # 16/16 turbo tasks
pnpm dev:api      # http://localhost:8787  (health: /health) — auto-loads .env
pnpm dev:desktop  # Tauri dev window
pnpm dev:web      # admin console
pnpm dev:worker   # retention/summaries (needs Redis)
```

In the desktop app: **Onboarding** → sign in (workspace auto-created) → **Home** → create a session → consent → **Start**. Then the stealth card: **Stealth overlay** (`Ctrl+Shift+O`), native mic / system-audio loopback toggles, capture exclusion, title masquerade. Screenshots route through `POST /v1/ai/vision` with OCR fallback.

## Testing

```sh
pnpm build
pnpm test         # node --test suites; api security/RAG integration tests auto-skip if Postgres is down
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Suites: contracts/domain/security (pure), audio-runtime (streaming engines, relay, moonshine, sherpa), ai-runtime (router, breakers, image/OCR, embeddings), api (STT relay HMAC, security: tenant isolation + auth + secret redaction, vector recall vs real pgvector).

## Benchmarks

```sh
pnpm bench:stt ; pnpm bench:coach ; pnpm bench:vision
node benchmarks/scoreboard.mjs                 # aggregates results/SCOREBOARD.md
node benchmarks/run-moonshine-speech.mjs       # real-speech local STT (SAPI corpus)
node benchmarks/run-sherpa-speech.mjs
node tests/load/realtime.mjs --concurrency 30 --seconds 20   # against a running API
node benchmarks/run-rival-parity.mjs           # rival-semantics comparison (see results/COMPARISON.md)
```

`benchmarks/README.md` documents the key matrix; `results/COMPARISON.md` is the evidence annex to `ARCHITECTURE_COMPARISON_VELARI_VS_RIVAL.md`.

## Packaging

```sh
pnpm --filter @app/desktop exec tauri build --bundles nsis
```
Updater keypair: `apps/desktop/keys/updater.key(.pub)`; signing env `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `.env`. Produces the signed NSIS installer + `.sig` updater artifact.

## Stealth — red-team surface

Capture invisibility (`SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE`), taskbar hiding (`WS_EX_TOOLWINDOW`), window-title masquerade, a `WH_KEYBOARD_LL` focus-free keyboard tap, and global chords (`RegisterHotKey` with a 10 s stolen-hotkey health poll) — all Tauri commands in `apps/desktop/src-tauri/src/stealth.rs` + `audio/` with self-verifying re-enforcement. See `docs/red-team/handoff-brief.md` for detection vectors and `docs/threat-model/threat-model.md` for scope.

This mode exists only for the academic make-then-break exercise.

## Troubleshooting

- **Port 5432 already allocated** — another local stack owns it; use the tests-override compose above (5433) and keep `DATABASE_URL` on 5433.
- **`pnpm exec prisma` not found** — run from `apps/api` via the local `.bin` binary (shown above).
- **PowerShell multi-line** uses backticks, not backslashes.
- **JSON config files corrupted after editing via PowerShell** — PS 5.1 `utf8` writes BOMs; write BOM-less (`UTF8Encoding($false)`).
- **OneDrive file locks** — `EPERM` during builds is transient; retry.
- **Local STT model missing** — Moonshine downloads on first use (~50 MB, HF hub); sherpa: `models/sherpa` via `ensureSherpaModel()`.

## Project status

Two verticals shipped on one binary:

- **Interview Intelligence** — dual-channel live transcription (you + interviewer), streaming STT with per-channel speaker attribution, judged coaching with style adaptation + rolling summaries + vector recall, post-session review with search, capture-excluded stealth overlay with focus-free keyboard tap and Piper TTS speak button.
- **Velari Work** — persisted task lifecycle (Prisma), policy-gated browser automation with approval/auto-approve, annotation service with Krippendorff's alpha agreement metrics, coding review (merged from coding-assistant), Studio authoring in the web console.

Infrastructure: 5-rung STT chain, provider router + circuit breakers, BYOK vault (AES-256-GCM), pgvector hybrid recall, vision/OCR, integration APIs (Gmail/Calendar/Slack), TTS, signed NSIS installer, 18/18 build, ~91 TS tests + 24 cargo tests, CI pipeline.

Backlog: `implementationplan.md` §5.1/§5.2 (macOS ports, real-corpus WER, rival-binary joint run, OAuth redirect flow).
