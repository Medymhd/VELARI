# App — Modular AI Agent Platform

First vertical: **Interview Intelligence** — dual-channel live transcription (you + interviewer), streaming STT, coaching frameworks with vector recall, post-session review, and a capture-excluded stealth overlay. Second vertical: **Velari Work** — persisted task lifecycle, policy-gated browser automation, annotation with agreement metrics, Studio authoring.

Brand is configured in one place: `packages/brand/src/index.ts`. Change the values there to rebrand the entire workspace.

## Architecture

- `apps/desktop` — Tauri 2 + React shell: native dual-channel audio (CPAL mic + WASAPI loopback), stealth layer, capture-excluded overlay, cropper
- `apps/web` — companion admin console + Studio authoring (same API)
- `apps/api` — Fastify + Prisma (Postgres + pgvector), WebSocket realtime (per-channel STT, judged coaching), STT relay, vision/OCR route, vector recall
- `apps/worker` — BullMQ retention and post-session summaries (Redis)
- `packages/audio-runtime` — STT engine chain: Deepgram streaming (paid) → Moonshine-tiny local (free, MIT) → sherpa Zipformer → Deepgram REST → local Whisper server → simulated
- `packages/ai-runtime` — provider router + circuit breakers, embeddings, vision, image/OCR, style profile
- `packages/work-runtime` / `assessment-engine` — task queue, assignment, lifecycle FSM; rubric scoring + calibration
- `packages/contracts` / `domain` / `security` / `observability` / `ui` / `brand` / `agent-sdk` — shared design system, contracts, approval framework
- `verticals/interview-intelligence` — coach prompts, auto-answer judge, agreement
- `verticals/work-assistant` — task lifecycle, policy gates, annotations, browser automation, coding review
- `benchmarks/` — STT, coach, vision, load, evaluation harnesses
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

Port note: the compose stack maps Postgres to **5433** (and Redis to 6380) so it never fights another local Postgres/Redis on 5432/6379. `.env` ships with `DATABASE_URL=…localhost:5433/app` to match.

PowerShell:
```powershell
docker compose -f infra/docker/docker-compose.yml up -d postgres

Set-Location apps\api
.\node_modules\.bin\prisma.cmd db push --skip-generate
Set-Location ..\..
```

bash:
```sh
docker compose -f infra/docker/docker-compose.yml up -d postgres
export DATABASE_URL="postgresql://app:app@localhost:5433/app"
(cd apps/api && ./node_modules/.bin/prisma db push --skip-generate)
```

The pgvector extension is created automatically (the compose image is `pgvector/pgvector:pg16`). Prisma note: raw SQL params arrive as TEXT — do not use `::uuid` casts against them.

### 3. Install & run

```sh
pnpm install
pnpm build        # 18/18 turbo tasks
pnpm dev:api      # http://localhost:8787  (health: /health) — auto-loads .env
pnpm dev:desktop  # Tauri dev window
pnpm dev:web      # admin console + Studio
pnpm dev:worker   # retention/summaries (needs Redis)
```

In the desktop app: **Onboarding** → sign in (workspace auto-created) → **Home** → create a session → consent → **Start**. Then the stealth card: **Stealth overlay** (`Ctrl+Shift+O`), native mic / system-audio loopback toggles, capture exclusion, title masquerade. Screenshots route through `POST /v1/ai/vision` with OCR fallback.

## Testing

```sh
pnpm build
pnpm test         # node --test suites; api security/RAG integration tests auto-skip if Postgres is down
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Suites: contracts/domain/security (pure), audio-runtime (streaming engines, relay, moonshine, sherpa), ai-runtime (router, breakers, image/OCR, embeddings, style profile), work-assistant (types, lifecycle, agreement), api (STT relay HMAC, security: tenant isolation + auth + secret redaction, vector recall vs real pgvector).

## Benchmarks

```sh
pnpm bench:stt ; pnpm bench:coach ; pnpm bench:vision
node benchmarks/scoreboard.mjs                 # aggregates results/SCOREBOARD.md
node benchmarks/run-moonshine-speech.mjs       # real-speech local STT (SAPI corpus)
node benchmarks/run-sherpa-speech.mjs
node benchmarks/run-work-eval.mjs              # real pipeline evaluation
node tests/load/realtime.mjs --concurrency 30 --seconds 20   # against a running API
```

## Packaging

```sh
pnpm --filter @app/desktop exec tauri build --bundles nsis
```
Updater keypair: `apps/desktop/keys/updater.key(.pub)`; signing env `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `.env`. Produces the signed NSIS installer + `.sig` updater artifact.

## Stealth

Capture invisibility (`SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE`), taskbar hiding (`WS_EX_TOOLWINDOW`), window-title masquerade, a `WH_KEYBOARD_LL` focus-free keyboard tap, and global chords (`RegisterHotKey` with a 10 s stolen-hotkey health poll) — all Tauri commands in `apps/desktop/src-tauri/src/stealth.rs` with self-verifying re-enforcement. The overlay supports 3 modes per vertical (stealth / assist / none) declared in the manifest.

## Troubleshooting

- **Port 5432 already allocated** — another local stack owns it; use the tests-override compose above (5433) and keep `DATABASE_URL` on 5433.
- **`pnpm exec prisma` not found** — run from `apps/api` via the local `.bin` binary (shown above).
- **PowerShell multi-line** uses backticks, not backslashes.
- **JSON config files corrupted after editing via PowerShell** — PS 5.1 `utf8` writes BOMs; write BOM-less (`UTF8Encoding($false)`).
- **OneDrive file locks** — `EPERM` during builds is transient; retry.
- **Local STT model missing** — Moonshine downloads on first use (~50 MB, HF hub); sherpa: `models/sherpa` via `ensureSherpaModel()`.
- **Piper TTS** — set `PIPER_PATH` (binary) and `PIPER_MODEL_PATH` (.onnx voice model); falls back to Web Speech API on the frontend when unset.

## Project status

Two verticals shipped on one binary:

- **Interview Intelligence** — dual-channel live transcription (you + interviewer), streaming STT with per-channel speaker attribution, judged coaching with style adaptation + rolling summaries + vector recall, post-session review with search, capture-excluded stealth overlay with focus-free keyboard tap and Piper TTS speak button.
- **Velari Work** — persisted task lifecycle (Prisma), policy-gated browser automation with approval/auto-approve, annotation service with Krippendorff's alpha agreement metrics, coding review, Studio authoring in the web console, agent runner with kill switch.

Infrastructure: 5-rung STT chain, provider router + circuit breakers, BYOK vault (AES-256-GCM), pgvector hybrid recall, vision/OCR, TTS, integration APIs, signed NSIS installer, 18/18 build, ~91 TS tests + 24 cargo tests, CI pipeline.
