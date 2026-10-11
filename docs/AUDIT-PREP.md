# Audit preparation

For an external reviewer. This page states what to review, what the code is supposed to guarantee, what
it assumes, how to rebuild the binaries, how to run the tests, what is already known, and which
questions we would most like answered. It does not describe an audit that has happened: **no external
audit has been done**. See [SECURITY.md](SECURITY.md) for the threat model and the internal review
history.

Everything below was measured on 2026-10-11, on macOS with Solana CLI 3.1.8 (platform-tools v1.52, rustc 1.89.0).

## 1. Scope

### 1.1 In scope (on-chain code that would hold or gate real value)

| Component | Path | Lines (`wc -l`, includes comments and inline unit tests) | Role |
|---|---|---:|---|
| Core program `agent_auth` | `src/` (12 files) | 1,272 | Mandate record, `verify` |
| Relay program `agent_auth_relay` | `programs/relay/src/` (16 files) | 3,574 | Hard enforcement for `transfer` and `swap` |
| Integrator crate `agent-auth-cpi` | `crates/agent-auth-cpi/src/` (5 files) | 691 | Library used by programs that CPI `verify`. Reviewed because integrators will copy it |
| Interface descriptions | `idl/core-idl.json`, `idl/relay-idl.json` | 2,046 | Source of truth for the SDK and CLI. Checked against the code by `tests/idl_conformance.rs` and `programs/relay/tests/conformance.rs` |

Program ids: core `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` (deployed on devnet, **baseline
lineage, not this code**); relay `33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6` (not deployed).

### 1.2 Lower priority

| Component | Path | Lines | Why |
|---|---|---:|---|
| Example integrator | `programs/gated-example/src/` | 146 | Shows the integrator pattern; an auditor can use it to judge the crate |
| TypeScript SDK | `packages/sdk` | about 22,000 added | Builds transactions, decodes accounts, mirrors on-chain checks. A bug here can make an owner sign a different policy than they meant. Pre-flight mirrors are conveniences; the chain decides |
| MCP server, CLI, guard | `packages/mcp`, `packages/cli`, `packages/guard` | about 15,700 | Handle keys (agent key only in the `agent` MCP profile) |

### 1.3 Out of scope (test and demo only; they must never be deployed)

`programs/mock-amm` (1,042 lines; a Raydium-CP-Swap-shaped AMM with 13 adversarial modes),
`programs/evil-token` (241 lines; a hostile Token stub for LiteSVM tests), `crates/agent-auth-cpi/tests/fixture-*`,
the dashboard (`apps/dashboard`) and the demo harness (`apps/demo`). The relay has a `test-amm` Cargo
feature that adds the mock AMM to the allow-list: `deploy-localnet/agent_auth_relay.so` is built with it
and is **localnet only**.

## 2. What the code is supposed to guarantee (invariants)

### 2.1 Core program

1. Only the account that signs as `mandate.owner` can create the mandate for its key, and can add, remove,
   update, pause, resume or revoke permissions. (`tests/error_matrix.rs`, 290 rows over all seven instructions.)
2. The mandate address is the canonical PDA `["mandate", owner, agent]` with a stored bump; the
   hot path does not derive addresses and makes no CPI (`tests/source_hygiene.rs`).
3. The account layout (2136 bytes), the `verify` ABI (tag 3, 49 bytes) and error codes 1 to 18 are frozen.
   `tests/layout.rs`, `tests/layout_v1.rs` and the golden fixtures pin the bytes.
4. `verify` changes only `spend_total` and `call_count` of the matched permission slot, and only when it
   returns success. A failing instruction rolls back (`poc_regressions.rs`). Other slots' counters are untouched
   (`regression_verify.rs::only_the_matched_slot_is_charged`).
5. Expiry, `owner`, `agent` and the permission list are not modified by `verify`
   (`poc_regressions.rs::expiry_never_changes_through_any_instruction`).
6. Check order is the order in the table in `src/error.rs`; each failure has one documented code.
7. `revoke_mandate` returns all lamports to the owner, shrinks data to 0 and assigns the account to the
   System Program. A mandate can be created again afterwards.
8. No `unsafe` outside the entrypoint macros, no `unwrap`, `expect`, indexing or panics reachable from input
   (`tests/source_hygiene.rs`, clippy deny lints).
9. Unlimited permissions (both limits 0) saturate instead of reverting; limited permissions that would
   overflow report `SpendLimitExceeded`.
10. A mandate that is pre-funded, over-funded or a program-owned zero account can still be created.

### 2.2 Relay

The full list is invariants I1 to I12 of the relay specification. In words:

- It calls out only to the AgentAuth core (`verify`), the policy-pinned Token / Token-2022 program
  (`TransferChecked`), the policy-pinned allow-listed AMM (`swap_base_input`) and the System Program
  (`init_policy`).
- The authority PDA signs only inside `transfer` and `swap`, only after `verify` returned success in the same
  instruction. The `amount` passed to `verify` equals the amount in the Token CPI (transfer) or `amount_in` in the
  AMM data (swap).
- For `transfer`, the source decreases and the destination increases by exactly `amount`, else the
  transaction reverts. For `swap`, the input account decreases by at most `amount_in`; the output account
  increases by at least the floor-derived minimum; the owner program, data length, owner field, close
  authority and delegate of both accounts are unchanged.
- The agent key is passed to exactly one CPI, `verify`. The relay never writes the policy in `transfer` or
  `swap`. After `init_policy` only the pause bit can change and only the owner can pause or close.
- Total tokens leaving the source through the relay cannot exceed the SPL `delegated_amount` the owner
  set. This holds independently of the relay, by the Token program's own check.
- Every failure reverts atomically.

Tests: `programs/relay/tests/inv.rs` (invariants), `tr.rs` (transfer), `sw.rs` (swap), `re.rs`
(re-entrancy and hostile callees), `dl.rs` (delegation), `uw.rs` (unwind), `pl.rs` (policy lifecycle),
`t22.rs` (Token-2022), `ar.rs` (arithmetic, replay), `fe.rs` (features and codes), `rt.rs` (red-team
regressions).

## 3. Trust assumptions

The properties above hold if the following do:

1. **The Token and Token-2022 programs** enforce `delegated_amount` on delegate transfers, and reject
   `Approve`, `Revoke`, `SetAuthority` and `CloseAccount` from a delegate. (Source-verified in the
   relay specification, section 3.2; cited from the `solana-program/token` repository.)
2. **The Solana runtime** enforces CPI rules: no indirect re-entrancy, no privilege escalation, atomic
   transactions, a maximum instruction stack height of 5.
3. **The pinned AMM** is the program the owner meant. The relay checks balance deltas and the price floor,
   not the AMM's internals. The compiled-in allow-list has one entry per cluster (the Raydium CP-Swap
   program id, or the mock under `test-amm`).
4. **Upgrade authorities** are honest or burned. This is the largest residual trust. Today the devnet
   core is upgradeable by one wallet, and no relay is deployed.
5. **The owner** reads what they sign. `init_policy` carries a large payload (recipients, pool, floor, enough that it needs its own
   transaction); the SDK is designed to render a preview, but a wallet signing blindly can be tricked.
6. **The cluster clock** is accurate enough for expiry and swap deadlines.
7. **Integrators** of the core (tier 3) derive the `verify` arguments from their own instruction, pin the
   AgentAuth id and bind `mandate.owner`.

## 4. Build reproducibility

### 4.1 Toolchain

- Solana CLI 3.1.8 (`cargo build-sbf` 3.1.8, platform-tools v1.52, rustc 1.89.0 for SBF)
- Host Rust from rustup (put `$HOME/.cargo/bin` first on `PATH`; Homebrew's cargo shadows rustup and
  breaks `cargo build-sbf`)
- Dependencies pinned by `Cargo.lock` (Pinocchio 0.9.3, pinocchio-system 0.4.0, pinocchio-pubkey 0.3)
- Release profile (core and relay): `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1`

### 4.2 Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
scripts/build-all.sh        # or: cargo build-sbf --manifest-path programs/relay/Cargo.toml  etc.
```

`build-all.sh` builds the core, the relay (default `devnet` feature), the relay with `--features test-amm`
(localnet only), the mock AMM, the example integrator, the hostile token stub and the integrator-crate
fixtures, then prints the hash of each.

### 4.3 sha256 of the artifacts as measured

Built on 2026-10-11 from commit `c8f5a39`. The same hashes came out of three independent target
directories on the same machine (the repository's `target/`, and two private ones), so the build is
deterministic on this machine and toolchain; a fresh clone of `233b994` built in a fourth directory gave the same
hashes. **It has not been compared across machines.**

| Artifact | Bytes | sha256 |
|---|---:|---|
| `deploy/agent_auth.so` (core) | 36,472 | `1e459e348907adf0c5b5d3606cfc00324de7628ca0cb6e550547413d6cfc09bc` |
| `deploy/agent_auth_relay.so` (devnet allow-list) | 64,032 | `ed6b884c3e33dc8b71a32c2465543f5c76b770064907433ff07479a5c130ea4f` |
| `deploy-localnet/agent_auth_relay.so` (`test-amm`; localnet only) | 64,104 | `ba02f32c9b3d33a1df5a3fe074a3805087385ae1aa96190a53da26ba5b614ad7` |
| `deploy/mock_amm.so` (test only) | 42,600 | `d71df55bf8f764ffd3b72b45faa497063cf0ba4ba1db3fed94ce2bdb40ebc139` |
| `deploy/gated_example.so` | 25,904 | `2086bceb3792bda2ef84c9751a4d9366d235dbb1db70567714c34ab71acb828b` |
| `deploy/evil_token.so` (test only) | 12,384 | `a2bfd0989af287eac1947cc70d0ca3896c4b7dd398a129f227f38155f1f9f28f` |

For comparison, the program deployed on devnet at `AKkih5Y...` is **not** this build: its bytes
with the trailing zero padding removed (29,593) have sha256 `bd52c6f45546fc7a41cc17368d1b18cb512c5e3a3b1ca6c6996e5412ee61b190`, and
the baseline build was 29,608 bytes with sha256
`68ce438b080eac059f3bbe13304d0de644a5a66fbbd779d3cfeb8d5dc73856c0` (the on-chain data carries zero
padding and the review found it matched the baseline build over the first 29,608 bytes).

### 4.4 Verifiable build (`solana-verify`): not done

A verifiable build ties deployed bytes to a public commit using a pinned Docker image. `solana-verify`
0.5.1 and Docker are installed on the author's machine, but **no verifiable build has been run or
published**, and the repository has no public remote yet. The procedure once there is a public repository
and a deployment:

```sh
# in a clean checkout of the release commit
solana-verify build --library-name agent_auth
solana-verify get-executable-hash target/deploy/agent_auth.so
solana-verify get-program-hash <PROGRAM_ID> -u devnet
# after a deployment, from the public repository (this sends a transaction that stores the build
# arguments on chain; only the key holder should run it):
solana-verify verify-from-repo -u devnet --program-id <PROGRAM_ID> --library-name agent_auth \
  --commit-hash <RELEASE_COMMIT> <PUBLIC_REPO_URL>
```

The executable hash of the verifiable build and the on-chain program hash must be equal. For the relay
(a program in a workspace subdirectory) add `--library-name agent_auth_relay` and the path options
`--mount-path` / `--workspace-path` described by `solana-verify verify-from-repo --help`. The
verifiable build uses a pinned Docker image whose toolchain can differ from the local Solana 3.1.8
toolchain used for the hashes in section 4.3, so its hash may differ from them; the verifiable-build hash
is the one that must match the chain. The flags above come from `solana-verify` 0.5.1's help output; **the
commands have not been run**.

## 5. Tests and how to run them

```sh
export PATH="$HOME/.cargo/bin:$PATH"
scripts/build-all.sh
source scripts/env.sh                      # sets AGENT_AUTH_SO, AGENT_AUTH_RELAY_SO, ... for the tests
cargo test --workspace --no-fail-fast      # the fuzz suites dominate the run time
pnpm install && pnpm -r --if-present test  # TypeScript packages (offline suites)
scripts/test-all.sh                        # all of the above
```

A missing `.so` is a hard failure; `AGENT_AUTH_ALLOW_SKIP=1` opts out and proves nothing.

### 5.1 Rust test inventory

`cargo test --workspace --no-fail-fast`, 2026-10-11, in a clean clone of commit `233b994`: **778 passed,
0 failed, 10 ignored** (47 result lines). The on-chain program sources (`src/`, `programs/*/src`, `crates/`) are
byte-identical between `c8f5a39`, on which the hashes in section 4.3 were first taken, and `233b994`; the
difference in test counts is new tests (mutation-survivor and witness tests, the RT-F7 pins).

| Crate | Passed | Ignored | Contents |
|---|---:|---:|---|
| `agent-auth` (core) | 141 | 8 | 11 unit tests; `error_matrix` 8 (290-row matrix); `regression_lifecycle` 32; `regression_verify` 13; `regression_cu` 4; `poc_regressions` 19; `state_unit` 21; `mutation_survivors` 8; `state_model` 2; `model_properties` 3 (differential against a model); `fuzz_program` 3 (2,400-transaction fuzz with structural invariants); `full_lifecycle` 3; `idl_conformance` 5; `layout` 1 and `layout_v1` 3; `source_hygiene` 5. Ignored: 6 devnet tests (need a funded devnet wallet) and 2 golden-file writers |
| `agent-auth-cpi` | 27 | 0 | 9 unit, 14 end-to-end tests against two fixture programs, 4 doc tests |
| `agent-auth-relay` | 529 | 2 | 40 unit; integration suites `tr` 67, `sw` 58, `witness` 45, `pl` 38, `dl` 40, `re` 39, `fe` 29, `rt` 22, `ar` 16, `uw` 16, `rt2` 14, `t22` 12, `conformance` 11, `smoke` 10, `inv` 8, and a 64-test harness self-check. Ignored: 2 real-Raydium swap tests (need a dumped devnet binary) |
| `gated-example` | 21 | 0 | Integration tests through `agent-auth-cpi` |
| `mock-amm` | 59 | 0 | 19 unit, 40 mode tests (the 13 adversarial modes) |
| `evil-token` | 1 | 0 | |

The TypeScript suites are separate. Counts are in [BENCHMARKS.md](BENCHMARKS.md) when that page is
generated.

### 5.2 What the tests do and do not show

- They run against the real compiled `.so` in LiteSVM, not a host mock. The relay's tests run it against
  classic `spl-token`, `p-token` and Token-2022 account shapes.
- The core suite was shown to kill 98 of 99 hand-written mutants, and 203 of 206 in the later campaign
  (3 proven equivalent, 4 real gaps closed by tests). The relay's suite killed 211 of 257 in its campaign
  (6 equivalent, 40 survivors, all 40 killed by `programs/relay/tests/witness.rs`), after an earlier 14
  of 15. These are self-review results on hand-written mutants chosen by the authors' own AI agents, not an
  independent audit and not a bug count. The mutants, runners, ledgers and equivalence proofs are in the
  repository: `python3 security/mutation-core/run.py --ids X02,V08,N-S31` and
  `python3 security/mutation-relay/run.py --ids C01,V16,D04` re-run a sample (`--all` the whole campaign;
  see [../security/README.md](../security/README.md) and [SECURITY.md](SECURITY.md), section 8, for the
  limits). The red-team harness is reproducible with `security/redteam-relay/run.sh` (see section 9 of
  SECURITY.md).
- LiteSVM is not the validator. A local validator end-to-end run exists
  (`scripts/localnet.sh`, `apps/demo`), not a mainnet-beta run.
- The relay's swap has been run against the **mock** AMM. Behaviour against the real Raydium binary and
  its compute cost are unmeasured.

### 5.3 Compute units (core, LiteSVM)

`cargo test --test regression_cu -- --nocapture`, 2026-10-11 (best / worst case of the test's scenarios;
values depend on the PDA bump where a search occurs):

| Instruction | CU best | CU worst |
|---|---:|---:|
| `verify` (slot 1 / slot 16, 8th discriminator, both limits) | 480 | 738 |
| `create_mandate` (fresh, 60 random agents) | 3,433 | 15,433 |
| `create_mandate` (pre-funded PDA) | 4,618 | 6,118 (depends on the random key; both seen on one binary) |
| `add_permission` | 243 | 420 |
| `update_permission` | 204 | 339 |
| `remove_permission` | 228 | 338 |
| `set_active` | 124 | 126 |
| `revoke_mandate` | 1,802 | 1,802 |

Relay figures and transaction sizes: [BENCHMARKS.md](BENCHMARKS.md).

## 6. Known limitations

See [SECURITY.md](SECURITY.md), section 10. The ones an auditor should keep in mind first: `verify` is
advisory on its own; `per_tx_limit` is per `verify` call, not per transaction (21 relay transfers fit in
one transaction); no rolling windows; one SPL delegate per token account; extension-free mints only; no
generation id on the mandate (a same-expiry re-creation re-binds an unclosed policy); the single-wallet
upgrade authority; swap CU against real Raydium unmeasured.

## 7. Review and fix history

| Date | Event | Reference |
|---|---|---|
| 2026-06-22 | Baseline: last pre-window commit of the capstone repository (not in-window work) | `ae67543` |
| 2026-10-10/11 | Seven-lens review of the baseline core: 86 raw findings (23 medium, 38 low, 25 info) | [SECURITY.md](SECURITY.md) section 7 |
| 2026-10-11 | Core hardening, ABI and layout locked | `cc6f1e6` |
| 2026-10-11 | Relay, integrator crate, mock AMM | `b0e7923`, `8a15927`, `31f0200` |
| 2026-10-11 | Core test suite replaced; 98 of 99 mutants killed | `326093f` |
| 2026-10-11 | Relay red team (about 1.4M fuzzed transactions); two fixes (RT-F3, RT-F4), regression tests | `7769968` |

All of it is internal and AI-assisted; none of it substitutes for an independent audit.

## 8. Suggested audit questions

1. **Relay `transfer`.** Is there any account list or token-account state for which `TransferChecked`
   succeeds but the destination is not in the policy's recipient list, or the amount passed to `verify`
   differs from the amount moved?
2. **Relay `swap` post-conditions.** Can a pinned AMM (or a Raydium state we did not model) leave the owner
   worse off than the floor allows while the post-checks pass, for example through the delegate-clearing rule
   at `delegated_amount == 0`, close authority, or Token-2022 shapes?
3. **Delegation.** Is there any path for the authority PDA to sign something other than the pinned
   `TransferChecked` or swap CPIs?
4. **Policy binding.** Are `mandate`, `policy`, `authority`, `owner`, `agent`, source and mint all bound so
   that no attacker-authored mandate or policy can reach a victim's token account? Do the
   witness tests (`programs/relay/tests/witness.rs`) that closed the relay mutation survivors
   ([SECURITY.md](SECURITY.md) section 8.2) pin everything that matters, and do any of the six
   equivalence proofs (`security/mutation-relay/EQUIVALENT.md`) fail?
5. **Generation binding.** Is the stored-expiry check (118) a sufficient generation guard given that the
   core has no nonce? Is there a sequence of revoke, create and init in one transaction that re-binds a
   stale policy to a different intent?
6. **Core PDA adoption.** Is the `create_mandate` path that adopts a pre-funded or program-owned zero account
   (Transfer, Assign, resize) correct for every starting lamport balance and owner, including rent edge
   cases?
7. **Core `revoke_mandate` close.** Can the close be undone within one transaction in a way that leaves a
   usable mandate or strands funds?
8. **`verify` accounting.** Are the saturating arithmetic for unlimited permissions and the exceeded-limit
   checks for limited ones correct at every boundary, including `u64::MAX`?
9. **Error mapping.** There is one deep-fuzz case where the relay failed with a runtime
   "Could not create program address" error rather than a relay code ([SECURITY.md](SECURITY.md) section 9).
   Is any path from that case reachable with a state change?
10. **Integrator crate.** Does `agent-auth-cpi` make the safe use easy and the unsafe use hard? Is
    `require_owner` the right default, and are there combinations of parsing and CPI that skip the pin?
11. **Token-2022.** The relay accepts extension-free mints and the 170-byte `ImmutableOwner`-only account
    shape. Are there accepted account shapes or mints with behaviour that changes the delta checks?
12. **Upgradeability and deployment.** What is the right authority model for the three programs, and how
    should the deployment be proved (verifiable build, multisig, timelock, burned authority)?
13. **SDK.** Do `init_policy` and unwind builders produce exactly what their previews show? Does the
    pre-flight ever say "ok" where the chain says no?
14. **Compute and size.** Are the relay's CU and size margins safe against the cluster feature changes
    (for example the stack-height change in SIMD-0268) we assume?
