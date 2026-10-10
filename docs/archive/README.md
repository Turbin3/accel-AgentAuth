# Archive: pre-hackathon capstone artifacts (June 2026)

These files come from the baseline snapshot (commit `7677fef`, files dated 2026-06-22; the design document's
metadata says it was created 2026-06-04). They are kept for provenance and for the disclosure in
[docs/DISCLOSURE.md](../DISCLOSURE.md). **They are superseded. Do not cite them.**

| File | Why it is superseded |
|---|---|
| `pre-hackathon/AgentAuthorizationProtocol_Overview.docx` | v0.1 design draft. Several statements are wrong or were later found inaccurate: "trustless", "no instruction-level gate exists in any shipped Solana protocol" (Squads' Smart Account Program has one), "irrevocably terminated" (revoke closes the account; re-creation is possible), the 81-byte header listing (it is 88), and the original instruction numbering. |
| `pre-hackathon/overview.png` | Hand-drawn overview with the pre-hardening instruction numbers (`[4] RemovePermission`, `[5] RevokeMandate`; the current tags are 2 and 4, and tags 5 and 6 were added). |
| `pre-hackathon/devnet-tests.png` | Screenshot of the baseline devnet test run. |

Current documentation: [README](../../README.md), [SPEC](../SPEC.md), [ARCHITECTURE](../ARCHITECTURE.md),
[COMPARISON](../COMPARISON.md), [SECURITY](../SECURITY.md).
