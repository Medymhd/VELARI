# Licensing

This project uses a **dual-license structure** to balance open-source contribution with commercial sustainability.

## License map

| Path | License | Why |
|---|---|---|
| `apps/api/` `apps/worker/` `verticals/` | **AGPL-3.0** | Server code. The network clause forces anyone running it as a SaaS to share their modifications. Prevents cloud providers from competing without contributing back. |
| `packages/audio-runtime/` `packages/ai-runtime/` `packages/work-runtime/` `packages/assessment-engine/` `packages/agent-sdk/` `packages/domain/` | **AGPL-3.0** | Core pipeline logic. Same rationale — if you run it, you share improvements. |
| `apps/desktop/` `packages/ui/` `packages/brand/` `packages/contracts/` `packages/security/` `packages/observability/` | **Apache-2.0** | Client + shared UI. Permissive to encourage adoption, includes explicit patent grant. |
| `apps/desktop/src-tauri/src/stealth.rs` `keyboard.rs` `keybind.rs` | **Proprietary** (all rights reserved) | The stealth layer is the competitive moat. Source-available for reading but not licensed for reuse or redistribution. |
| `packages/contracts/src/work.ts` `packages/agent-sdk/src/approval.ts` | **AGPL-3.0** | Approval and policy contracts are platform-critical. |

## Contributor terms

All contributions are subject to the CLA in `CLA.md`. By submitting a PR you grant the project owners the right to include your contribution under any of the above licenses (or a future proprietary license) without restriction.

## Commercial licensing

Organizations who cannot accept AGPL-3.0 (e.g. SaaS providers, enterprise with copyleft restrictions) may purchase a commercial license for the server components. Contact the maintainers.

## Stealth layer

The stealth layer (capture exclusion, keyboard interception, window masquerade, global chords) is **source-available but proprietary**. You may read the code to understand the techniques but you may not redistribute it, use it in your own product, or create derivative works. This is the project's competitive differentiation and the core of the red-team exercise.

## Trademark

The product name (see `packages/brand`) is not covered by any open-source license. Forks must rename.
