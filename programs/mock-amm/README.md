# mock-amm

> ## DO NOT DEPLOY TO MAINNET
>
> This is **test and demo infrastructure**. It is a toy constant-product AMM with deliberately
> hostile modes. It has no fees, no LP accounting, no oracle, no admin controls and has not been
> audited. The AgentAuth relay only allowlists it behind the `test-amm` cargo feature; a mainnet
> relay build must not include that feature.

`mock-amm` implements the Raydium CP-Swap `swap_base_input` ABI (same 13 accounts in the same
order, 24-byte instruction data starting with the Anchor discriminator `8fbe5adac41e33de`) on a
toy pool, so the AgentAuth relay's `swap` can be tested and demoed without a real Raydium pool.
A pool's byte 0 selects one of 13 behaviours: one honest, twelve adversarial. The LiteSVM tests
in `tests/modes.rs` prove what each mode does against the real Token, p-token and Token-2022
binaries; they are the specification a reviewer should read.

Program id (throwaway key, test/demo only): `6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw`.

## Instructions

Every instruction starts with an 8-byte discriminator.

| Discriminator | Name | Data after it | Accounts |
|---|---|---|---|
| `8fbe5adac41e33de` | `swap_base_input` | `amount_in u64 LE`, `minimum_amount_out u64 LE` (24 bytes total) | the 13 below |
| `FF 70 72 6F 78 79 00 00` | `proxy` | inner instruction data | `[program, ...rest]` (at most 32 in `rest`), forwarded with their signer/writable flags |
| `FF 69 6E 69 74 00 00 00` | `init_pool` | `mode u8`, `aux_key [u8;32]` | `[pool_state W, vault_0, vault_1]` |

`swap_base_input` accounts (Raydium order; extra trailing accounts are allowed):

| # | Account | Flags | Notes |
|---|---|---|---|
| 0 | `payer` | signer | authority of the input transfer (token owner or delegate; the relay's PDA in production use) |
| 1 | `authority` | | pool authority PDA `["mock_amm_auth"]`, token owner of both vaults |
| 2 | `amm_config` | | accepted, unused |
| 3 | `pool_state` | W | owned by this program, 104 bytes |
| 4 | `input_token_account` | W | |
| 5 | `output_token_account` | W | |
| 6 | `input_vault` | W | one of the pool's two vaults |
| 7 | `output_vault` | W | the other one |
| 8 | `input_token_program` | | Token (classic or p-token) or Token-2022 |
| 9 | `output_token_program` | | same set |
| 10 | `input_token_mint` | | |
| 11 | `output_token_mint` | | |
| 12 | `observation_state` | W | accepted, unused |

Behaviour of an honest swap (`NORMAL`): `out = floor(amount_in * out_reserve / (in_reserve + amount_in))`
computed in u128 from the live vault balances (`data[64..72]` of each vault), no fee. The input is
pulled with Token `TransferChecked` (authority = `payer`), the output is paid with `TransferChecked`
signed by the pool authority PDA. If `out < minimum_amount_out` it fails with 7001; a zero
`amount_in` or a zero output fails with 7004.

`proxy` exists to test stack-height rules: running an instruction through it puts that
instruction at stack height 2, so the relay's `STRICT_TOP_LEVEL` flag must reject it (relay
error 115) and a flag-less relay must still work.

## `pool_state` layout (104 bytes, owner = this program)

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `mode` | 0..=12, see below; anything else is `InvalidPool` |
| 1 | 7 | zero | must be zero |
| 8 | 32 | `vault_0` | token account holding one side |
| 40 | 32 | `vault_1` | token account holding the other side |
| 72 | 32 | `aux_key` | attacker key or mandate key, used by modes 3, 4, 5, 8 |

Both vaults must be initialised token accounts, owned by the program that is passed as the
corresponding token program, whose token-level owner is the pool authority PDA and whose mint is
the matching mint.

### Creating a pool in a LiteSVM test

```rust
use mock_amm::{Mode, PoolState, MOCK_AMM_ID, POOL_AUTHORITY_SEED};

let authority = Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &Pubkey::from(MOCK_AMM_ID)).0;
// two 165-byte token accounts (state = 1) whose token owner is `authority`, one per mint,
// holding the reserves, installed with set_account (see tests/common/mod.rs::token_account)
let state = PoolState { mode: Mode::Normal, vault_0: in_vault.to_bytes(), vault_1: out_vault.to_bytes(), aux_key: [0; 32] };
svm.set_account(pool, Account {
    lamports: svm.minimum_balance_for_rent_exemption(104),
    data: state.encode().to_vec(),   // exactly 104 bytes
    owner: Pubkey::from(MOCK_AMM_ID),
    ..Default::default()
})?;
```

`tests/common/mod.rs` has a complete, tested builder (`World::new`) that also creates mints,
user accounts, delegations and the swap instruction.

### Creating a pool on a cluster

`set_account` is not available on a cluster, so use `init_pool`: in one transaction, System
`CreateAccount { space: 104, owner: MOCK_AMM_ID, lamports: rent }` for a fresh pool keypair
(the pool keypair signs), then `init_pool` with `[pool W, vault_0, vault_1]` and data
`FF 69 6E 69 74 00 00 00 | mode | aux_key`. The pool account must be all zero; a second
`init_pool` on the same account fails with 7002. The vaults must be token accounts owned by the
pool authority PDA and funded by the caller (any token transfer into them).

## The 13 modes

| Mode | Name | What the swap does |
|---|---|---|
| 0 | `NORMAL` | honest constant-product swap |
| 1 | `PULL_EXTRA` | normal output, but pulls `amount_in + 1` from `input_token_account` |
| 2 | `BURN_IN` | normal swap, then Token `Burn` of 1 unit from `input_token_account` signed by `payer`. Needs the input mint to be writable; the relay passes it read-only, so under the relay the runtime refuses the CPI with `PrivilegeEscalation` |
| 3 | `APPROVE_ATTACKER` | normal swap, then Token `Approve(u64::MAX)` on `input_token_account` to `aux_key` (looked up among the passed accounts; falls back to `output_token_account` if absent). Succeeds only if `payer` is the token owner; for a delegate the Token program returns `OwnerMismatch` (Custom 4) |
| 4 | `SET_AUTH` | normal swap, then Token `SetAuthority(AccountOwner)` on `input_token_account` to `aux_key`. Same owner-vs-delegate outcome as mode 3 |
| 5 | `CLOSE_ACCOUNT` | normal swap, then Token `CloseAccount` on `input_token_account`, lamports to the `aux_key` account if passed (else `observation_state`). Needs an empty account and the token owner as `payer`; otherwise Token returns `NonNativeHasBalance` (Custom 11) or `OwnerMismatch` (Custom 4) |
| 6 | `REDIRECT_OUTPUT` | pays the output into `input_token_account` instead of `output_token_account`. With two distinct mints (every relay policy) the Token program rejects it with `MintMismatch` (Custom 3); on a same-mint pool the redirect completes |
| 7 | `REENTER_RELAY` | normal swap, then a CPI to the relay program id with the accounts it received. The callee program account must be among those accounts (without it: `MissingAccount`); with it, the runtime rejects the A -> B -> A call with `ReentrancyNotAllowed` |
| 8 | `CPI_VERIFY` | normal swap, then AgentAuth `verify(mock_amm, SWAP_DISC, amount_in)` using `aux_key` as the mandate. Needs the mandate, its owner and its agent (as a signer) among the accounts; under the relay none is passed, so it fails with `NotEnoughAccountKeys` |
| 9 | `NOOP_OK` | returns Ok and moves nothing |
| 10 | `UNDERPAY` | pulls `amount_in`, pays `minimum_amount_out - 1` (saturating) |
| 11 | `PULL_LESS` | pulls `amount_in / 2`, pays the constant-product output for that smaller input |
| 12 | `BURN_CPU` | spins until the compute budget is exhausted (`ProgramFailedToComplete`) |

## Errors

| Code | Name | Raised when |
|---|---|---|
| 7001 | `ExceededSlippage` | computed output below `minimum_amount_out` |
| 7002 | `InvalidPool` | pool not owned by the program, wrong length, unknown mode byte, dirty reserved bytes, wrong authority, not a Token/Token-2022 program id, bad mint; also a repeated `init_pool` |
| 7003 | `InvalidVault` | vault not one of the pool's two (one per side), wrong mint, wrong token owner, wrong token program, same vault on both sides |
| 7004 | `ZeroAmount` | `amount_in == 0` or the swap would pay out zero |
| 7005 | `InvalidInstruction` | unknown discriminator, wrong data length, bad mode in `init_pool`, more than 32 forwarded accounts |

Token-program errors surface as the Token program's own `Custom(n)`. Codes overlap across
programs, so read the failing program id in the logs.

## Build and test

```sh
export PATH="$HOME/.cargo/bin:$PATH"                       # must precede Homebrew's cargo
cargo build-sbf --manifest-path programs/mock-amm/Cargo.toml
cargo build-sbf --manifest-path Cargo.toml                  # core agent_auth.so (mode 8 tests)
export MOCK_AMM_SO=$CARGO_TARGET_DIR/deploy/mock_amm.so
export AGENT_AUTH_SO=$CARGO_TARGET_DIR/deploy/agent_auth.so
cargo test -p mock-amm
```

A missing `.so` is a hard test failure; `AGENT_AUTH_ALLOW_SKIP=1` opts out. Each LiteSVM test runs
against classic spl-token, p-token (LiteSVM feature `replace_spl_token_with_p_token` on) and
Token-2022 (extension-free accounts).
