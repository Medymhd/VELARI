# Velari — Modular AI Agent Platform

Velari is a unified AI workspace with specialized agents built on one foundation: identity, memory, permissions, model routing, and audit. The flagship vertical, **Interview Intelligence**, now serves both sides of the table via a sidebar persona switch (candidate is default): **Candidate mode** delivers real-time live-interview support — dual-channel transcription (you + the interviewer), coached answers in about a second, prepared-answer recall, deterministic speech analytics, and a capture-excluded stealth overlay — plus **Arena** practice with scored rounds and a story bank. **Interviewer mode** flips the table for recruiters/HR: a laddered question sheet crafted from the candidate's CV + JD, live follow-up probes, an answer-signal read, and talk-time tracking. **Velari Work** adds a persisted task lifecycle, policy-gated browser automation, annotation with agreement metrics, and Studio authoring.

Brand is configured in one place: `packages/brand/src/index.ts`. Change the values there to rebrand the entire workspace.

## Architecture

- `apps/desktop` — Tauri 2 + React shell: native dual-channel audio (CPAL mic + WASAPI dual-endpoint loopback), stealth layer, capture-excluded overlay, cropper, browser-capture companion
- `apps/web` — companion admin console + Studio authoring (same API)
- `apps/api` — Fastify + Prisma (Postgres + pgvector), WebSocket realtime (per-channel STT, single-flight coaching), STT relay, vision/OCR route, vector recall, session prep materials
- `apps/worker` — BullMQ retention and post-session summaries (Redis)
- `packages/audio-runtime` — STT engine chain: Deepgram streaming (paid, optional) → Moonshine-tiny local (free, MIT, in-server proven) → sherpa Zipformer (true streaming) → Deepgram REST → local Whisper server → simulated. Without a Deepgram key the free local pair runs first and the chain degrades gracefully.
- `packages/ai-runtime` — provider router + circuit breakers, task-scoped model profiles, embeddings, vision, image/OCR, style profile
- `packages/work-runtime` / `assessment-engine` — task queue, assignment, lifecycle FSM; rubric scoring + calibration
- `packages/contracts` / `domain` / `security` / `observability` / `ui` / `brand` / `agent-sdk` — shared design system, contracts, approval framework
- `verticals/interview-intelligence` — coach prompts, auto-answer judge, prepared-answer recall, post-processing, deterministic speech analytics (`analytics.ts`: filler rate, WPM, STAR-share, per-metric verdicts), and interviewer-mode question-sheet generation (`interviewerSheet.ts`)
- `verticals/work-assistant` — task lifecycle, policy gates, annotations, browser automation, coding review
- `benchmarks/` — STT, coach, model-ranker, vision, self-interview simulation, load, evaluation harnesses
- `infra/docker/` — Postgres (pgvector) / Redis / MinIO

**Free-and-open operating mode:** everything runs end-to-end at $0 — local Moonshine/lexicon models for transcription, free inference tiers (Groq, OpenRouter `:free`) for reasoning, simulated fallbacks everywhere else. Paid providers are optional rungs behind the same contracts.

## Live session intelligence (what makes it real-time)

- **Dual-channel capture** — native mic (CPAL) and system loopback (dual-endpoint WASAPI covering both media and communications endpoints) are captured, gated, resampled and attributed to the right speaker automatically
- **Warm before you speak** — STT engines load at session open (and Moonshine weights once per API process, kicked at boot), so the first question is never buffered behind a model download; keep-warm pings hold the provider connection open between questions
- **Dictation-style partials** — each utterance is one evolving line that commits in place; no transcript clutter
- **Answer-first pipeline** — a question-shaped final drafts the speakable answer immediately (one LLM round-trip), then the coach framework follows; one LLM call in flight at any moment keeps free tiers out of 429 storms
- **Two-part drafted answers** — direct response to the question as asked (definitional questions stay persona-free) + an optional crimson-tinted grounding paragraph with a CV-grounded instance; the JD is the objective every answer optimizes for, the CV the constraint it may never contradict
- **Single-flight coaching with interruption preemption** — a new utterance aborts any in-flight LLM call; a 900 ms confirmation window makes sure the speaker has truly finished before the coach crafts an answer; a first-token "crafting answer…" indicator replaces dead air while the LLM generates
- **Tolerant answer cache** — a question asked (nearly) before is answered in ~0 ms without an LLM call: normalized exact match → stem-lite token-overlap fuzzy match (≥0.80) → vector cosine over hashed embeddings (≥0.92). Only judge-accepted answers are cached; changed prep materials auto-invalidate (`prepHash`); hits are badged "cached" with the matched question shown on fuzzy hits
- **Prepared-answer recall** — your uploaded Q&A bank answers drilled questions in ~0 ms, ahead of both the cache and the LLM
- **ASR self-correction** — the coach silently normalizes mishears ("a eye training data" → "AI training data") using your prep-material vocabulary; low-confidence questions are flagged with a yellow "verify" chip instead of answered blindly
- **Response ring system** — green ring = newest response, yellow = low-confidence question, blue = older ones, in both the main panel and the overlay
- **Response length modes** (short / medium / long), 9 mode personas, style adaptation learned from your own speech
- **Always answers** — when the LLM output is unusable, a structural offline scaffold is shown instead of silence
- **Session lifecycle done right** — new sessions start clean, any session (including completed ones) reopens with its full transcript and insights restored, and a "Reopen session" button continues capture
- **Speech analytics** — deterministic per-session metrics (filler rate per 100 words, WPM over timed segments, STAR-structured share, words/answer) with good/ok/warn verdicts; persisted as insights so they appear in Review and the PDF export, rendered as metric chips with cross-session sparklines in Review and a progress-trend strip in Arena
- **Post-interview follow-up** — thank-you email + honest debrief grounded in the measured speech metrics
- **Stealth overlay** — answer-first card stack (latest drafted answer pinned on top in green, prepared hits beneath, frameworks at the bottom) with a live interviewer-question strip, driven by Rust-emitter event forwarding that works from every screen, with `Ctrl+Shift+O` toggle, `Ctrl+Shift+P` position cycling, `Ctrl+Shift+B` click-through passthrough, `Ctrl+Shift+H` app show/hide
- **Session auto-naming** — the model titles new sessions from the CV/JD (or the opening transcript) once material exists; user-typed names are never overwritten, rename anytime
- **Post-session review** — persisted transcript and insights with search and print-to-PDF export; per-session delete (transcripts, insights, artifacts and prep materials cascade)

### Interviewer mode (recruiters / HR)

Flip the `Candidate | Interviewer` switch in the sidebar footer (blocked mid-live-session; candidate remains the default):

- **Prep** — create an interviewer session, add the candidate's CV + job description (paste or upload pdf/docx/xlsx/csv/txt through the same server-side extraction pipeline candidates use), then generate a laddered question sheet: warmup → core → pressure, each question with its intent, what a good answer contains, and follow-up probes. Works fully offline via a keyword-driven fallback sheet
- **Live interview** — the candidate-coaching panel is replaced by an interviewer aid: the sheet as a mark-asked checklist, one-click "Suggest probe" from the live transcript with a strong/shallow/off-track answer signal, and the talk-time meter relabeled You / Candidate
- Sessions are tagged `kind=interviewer` in session metadata and surface in Review like any other; `/interviewer/sheet` and `/interviewer/probe` are declared in the vertical manifest

## Model routing: BYOK + benchmark-driven ranking

Velari is model-agnostic. Keys stay in your workspace vault (AES-256-GCM sealed); managed keys are optional.

- **Bring your own OpenAI-compatible endpoint** — base URL + key is all it takes; the platform tests your models against the real coach prompt
- **Built-in test-and-ranker** — `pnpm bench:models` discovers every live model on your configured gateways (Groq, OpenRouter, OpenAI-compat, Gemini), benchmarks streaming TTFT, total latency and strict-JSON reliability, and writes the winners into the router (`COACH_MODEL_*`). Deprecated, renamed or rate-limited models are replaced automatically on the next run. Schedule it at launch (default), hourly, every 4 hours, daily, or off — or run **Settings → Probe now** for an on-demand ranked table and apply a winner manually (same-gateway runners-up become fallbacks; effective on the next session connect, no restart). At request time, a 429 with `Retry-After` excludes that candidate for exactly the provider's window — no blind re-picks against a rate-limited tier.
- **Measured reference points** (see `benchmarks/results/`): Groq's `qwen/qwen3.8-27b` is the fastest strict-JSON free model measured (TTFT ~200-400 ms, ~0.5-1 s total), with `openai/gpt-oss-20b` and `groq/compound-mini` as measured failovers and Groq's tiny `allam-2-7b` (~277 ms TTFT) as a speed-over-depth alternative. Gemini's free flash models were measured unusable for realtime JSON (thinking-token truncation, 503 capacity); the gateway stays in the probe for future re-checks. OpenRouter's free pool is supported as a $0 fallback rung.

## Getting started

Prerequisites: Node ≥ 22, pnpm 10 (`corepack enable`), Rust toolchain (for the desktop shell), Docker Desktop, Windows 10/11 for native audio + stealth (macOS/Linux compile with degraded features).

### 1. Environment

```sh
cp .env.example .env
```

Set at minimum: `DATABASE_URL`, `JWT_SECRET`, `SECRET_MASTER_KEY`. Optional keys unlock cloud rungs: `DEEPGRAM_API_KEY` (streaming partials), `GROQ_API_KEY` (managed LLM routing), `OPENROUTER_API_KEY`, `OPENAI_COMPAT_BASE_URL`/`OPENAI_COMPAT_API_KEY` (BYOK benchmarking). Unset = the free stack is used automatically.

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
pnpm build        # 25/25 turbo tasks
pnpm dev:api      # http://localhost:8787  (health: /health) — auto-loads .env
pnpm dev:desktop  # Tauri dev window
pnpm dev:web      # admin console + Studio
pnpm dev:worker   # retention/summaries (needs Redis)
```

In the desktop app: **Onboarding** → sign in (workspace auto-created; the session persists across restarts) → **Home** → create a session → consent → **Start**. Upload prep materials (JD / CV / notes / drilled Q&A) on the live screen, flip on **Native mic** and **Native system audio (loopback)**, then the stealth card: **Stealth overlay** (`Ctrl+Shift+O`), capture exclusion, title masquerade. Screenshots route through `POST /v1/ai/vision` with OCR fallback.

## Testing

```sh
pnpm build
pnpm test         # node --test suites; api security/RAG integration tests auto-skip if Postgres is down
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Suites: contracts/domain/security (pure), audio-runtime (streaming engines, relay, moonshine, sherpa), ai-runtime (router, breakers, image/OCR, embeddings, style profile), interview-intelligence (coach prompts, judge, prepared recall, post-processing, speech analytics, question-sheet normalization), work-assistant (types, lifecycle, agreement), api (STT relay HMAC, security: tenant isolation + auth + secret redaction, vector recall vs real pgvector).

## Benchmarks

```sh
pnpm bench:models    # discover + rank every live model on your gateways → COACH_MODEL_* in .env
pnpm bench:stt ; pnpm bench:coach ; pnpm bench:vision
node benchmarks/run-interview.mjs               # self-interview simulation: per-question latency + degradation curve
node benchmarks/scoreboard.mjs                  # aggregates results/SCOREBOARD.md
node benchmarks/run-moonshine-speech.mjs        # real-speech local STT (SAPI corpus)
node benchmarks/run-sherpa-speech.mjs
node benchmarks/run-work-eval.mjs               # real pipeline evaluation
node tests/load/realtime.mjs --concurrency 30 --seconds 20   # against a running API
```

The interview harness replays a full question bank through the real coach chain with a growing transcript and reports the latency drift — flat means the single-flight/preemption pipeline is healthy.

## Packaging

```sh
pnpm --filter @app/desktop exec tauri build --bundles nsis
```

Updater keypair: `apps/desktop/keys/updater.key(.pub)`; signing env `TAURI_SIGNING_PRIVATE_KEY_PATH` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `.env`. Produces the signed NSIS installer + `.sig` updater artifact. App icons are generated from the Orbit brand mark in `packages/brand/logos/`.

## Stealth

Capture invisibility (`SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE`), taskbar hiding (`WS_EX_TOOLWINDOW`), window-title masquerade, a `WH_KEYBOARD_LL` focus-free keyboard tap, and global chords (`RegisterHotKey` with a 10 s stolen-hotkey health poll) — all Tauri commands in `apps/desktop/src-tauri/src/stealth.rs` with self-verifying re-enforcement. The overlay supports 3 modes per vertical (stealth / assist / none) declared in the manifest.

## Troubleshooting

- **Port 5432 already allocated** — another local stack owns it; use the compose file above (5433) and keep `DATABASE_URL` on 5433.
- **`pnpm exec prisma` not found** — run from `apps/api` via the local `.bin` binary (shown above).
- **PowerShell multi-line** uses backticks, not backslashes.
- **JSON config files corrupted after editing via PowerShell** — PS 5.1 `utf8` writes BOMs; write BOM-less (`UTF8Encoding($false)`).
- **Mojibake (`â€"`, `â†'`, `â"€`) in source or `.env`** — UTF-8 was written through the CP1252 codepage at some point; the fixer script pattern (codepoint-mapped replacement, iterate to convergence) is in session history. Prevention: always write files BOM-less UTF-8 from PowerShell.
- **OneDrive file locks** — `EPERM` during builds or `prisma generate` (a running API holds the query engine) is transient; stop the API and retry.
- **Local STT model missing** — Moonshine downloads on first use (~50 MB, HF hub); sherpa: `models/sherpa` via `ensureSherpaModel()`.
- **Piper TTS** — set `PIPER_PATH` (binary) and `PIPER_MODEL_PATH` (.onnx voice model); falls back to Web Speech API on the frontend when unset.
- **Coach answers empty** — check the API terminal for `pipeline.warning` frames; the offline scaffold still appears in the panel when the LLM is unreachable.
- **Answers show "cached"** — that's the answer cache serving a question asked (nearly) before at 0 ms; fuzzy hits show the question they were originally answered as. Change your prep materials to invalidate.

## Project status

Three verticals ship on one binary:

- **Interview Intelligence** — real-time dual-channel live support as described above, deterministic speech analytics with cross-session trends, post-interview follow-up drafting, and interviewer mode (question sheets + live probes) behind the persona switch; post-session review with search and export.
- **Velari Work** — persisted task lifecycle (Prisma), policy-gated browser automation with approval/auto-approve and durable run history, annotation service with Krippendorff's alpha agreement metrics, coding review, Studio authoring in the web console, agent runner with kill switch.
- **Velari Copilot** — durable conversational research chat (Postgres-backed threads that survive restarts, markdown-rendered answers, workspace-scoped history; user-facing name, stable `research` id).

Infrastructure: multi-rung STT chain, provider router + circuit breakers + task-scoped model profiles + Retry-After-aware rate-limit penalties, tolerant answer cache, BYOK vault (AES-256-GCM), pgvector hybrid recall, vision/OCR, TTS, integration APIs, signed NSIS installer, 25/25 build, 33 interview-vertical + 12 answer-cache + 12 work + 35 ai-runtime tests + 24 cargo tests, CI pipeline.

## License

Dual-licensed: server and verticals under AGPL-3.0 (`LICENSE-APPL.md`), client/UI under Apache-2.0 (`LICENSE-CLIENT.md`), stealth layer proprietary (`apps/desktop/src-tauri/src/stealth/LICENSE`). Contributions require the CLA (`CLA.md`).
