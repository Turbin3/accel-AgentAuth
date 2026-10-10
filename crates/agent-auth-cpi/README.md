# agent-auth-cpi

Safe-by-default helper for Solana programs (Pinocchio, `no_std`, one dependency) that want to
check an [AgentAuth](../../README.md) mandate before they let an agent move funds or change state.

> Status: unaudited devnet prototype. Not published to crates.io; use it as a path or git dependency.

AgentAuth mandates are **advisory unless you enforce them**: the core program records what an owner
allowed an agent to do, and *your program* is what actually refuses or performs the action. Calling
`verify` correctly has two confused-deputy traps. This crate closes both by construction:

| Trap | What goes wrong | How the crate prevents it |
|---|---|---|
| **Program id from the transaction** | An attacker passes a "yes-man" program as "AgentAuth"; your `verify` call is approved by the attacker's own code. | `VerifyCpi` always invokes the hard-coded `AGENT_AUTH_ID` and rejects any other program account (`WrongAgentAuthProgram`). |
| **Mandate owner not bound to the funds** | Anyone can create a mandate that names any agent with *themselves* as owner. If you spend from a treasury that is not tied to the mandate's owner, the attacker's own mandate authorises spending someone else's money. | `expected_owner` is a **required field**; the mandate must name exactly that owner (`OwnerMismatch`). |

## Use

```toml
[dependencies]
agent-auth-cpi = { path = "../agent-auth-cpi" }   # or a git dependency
```

```rust
use agent_auth_cpi::{disc8, VerifyCpi};

VerifyCpi {
    agent_auth_program: auth,          // account from the tx; checked against AGENT_AUTH_ID
    mandate, owner, agent,             // mandate (writable), owner (read), agent (signer)
    expected_owner: &vault_owner,      // from YOUR state, not from the caller (see checklist)
    target_program: &SYSTEM_PROGRAM,   // what the agent is about to call
    disc: disc8::SYSTEM_TRANSFER,      // 8-byte canonical instruction discriminator
    amount: lamports,                  // the REAL amount you are about to move
}
.invoke()?;
// verified; now perform exactly that action, out of the vault controlled by `vault_owner`
```

Complete, tested example: [`tests/fixture-caller/src/lib.rs`](tests/fixture-caller/src/lib.rs) (about 100
lines: verify, then a System transfer out of the PDA `["treasury", expected_owner]`).

## What `invoke()` checks before the CPI

1. the AgentAuth program account is `AGENT_AUTH_ID`
2. the mandate account is owned by `AGENT_AUTH_ID`, is 2136 bytes, has discriminator `1`
3. the mandate account is writable and not already borrowed
4. `mandate.owner == expected_owner` and the `owner` account is `expected_owner`
5. `mandate.agent` is the `agent` account
6. the agent signed the transaction (`invoke_signed` accepts PDA signer seeds instead)

Then it calls `verify` (tag `3` + target program `[32]` + `disc8` `[8]` + amount `u64` LE = 49 bytes;
accounts `mandate (W)`, `owner (R)`, `agent (S)`). Active/expiry, the program and instruction allow-list
and the per-transaction/lifetime limits are enforced by AgentAuth itself and its error propagates
unchanged. A failed CPI aborts the whole transaction; it cannot be swallowed.

Errors raised by this crate are `ProgramError::Custom(0x4141_0001 ..= 0x4141_000A)` (`CpiError`), a range
that cannot collide with the core's `1..=22`.

## API

| Item | Purpose |
|---|---|
| `AGENT_AUTH_ID` | the real core program id, `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` |
| `VerifyCpi { .. }` | all fields required; `.invoke()`, `.invoke_signed(&[Signer])`, `.preflight()` (checks only, no CPI) |
| `verify_instruction_data(program, disc, amount)` | the 49-byte `verify` payload |
| `MandateHeader::parse(account.owner(), &data)` | zero-copy view: `owner()`, `agent()`, `expiry()`, `active()`, `is_expired(now)`, `require_owner`, `require_agent`; only constructs from a real, correctly sized mandate |
| `CpiError` | typed pre-CPI errors, `code()`, `from_code()`, `as_str()`, `Into<ProgramError>` |
| `disc8::{from_u8_tag, from_u32_tag, from_prefix, SYSTEM_TRANSFER, SPL_TOKEN_TRANSFER, SPL_TOKEN_TRANSFER_CHECKED}` | `const fn` builders for the canonical `disc8` |

### Computing `disc8`

* 1-byte-tag programs (SPL Token, Token-2022): `disc8::from_u8_tag(12)` (tag, then 7 zero bytes; never the first
  8 raw instruction bytes, which for `Transfer` contain part of the amount).
* u32-LE-tag programs (System, Stake): `disc8::from_u32_tag(2)`.
* Anchor programs: the first 8 bytes of instruction data, `sha256("global:<snake_case_name>")[..8]`. SHA-256
  is not available in a `no_std` const context, so precompute once and paste it:
  `printf 'global:swap_base_input' | shasum -a 256 | cut -c1-16` gives `8fbe5adac41e33de`, then
  `const SWAP: [u8; 8] = disc8::from_prefix(&[0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);`.
  The verified registry (`packages/registry`, `disc8` field) lists these values for known programs.

## Security checklist for integrators

1. **Source `expected_owner` from your own state** (a vault PDA seeded by the owner key, a stored authority
   field). Never from instruction data or an account the agent picks. Make the funds follow it: sign for a PDA
   derived from that same owner so a mandate can only ever spend its own owner's money.
2. **Report the real amount and the real `(target_program, disc8)`**, computed from the same values you act on.
   `verify` cannot see what your program does afterwards; this is advisory authorisation, not enforcement of
   the action itself.
3. **Verify first, act second, in the same instruction.** No cached approvals, no code path that moves value
   without it.
4. **Include the AgentAuth program account and a writable mandate** in your instruction's accounts.
5. **Do not hold a borrow of the mandate data across the call.**
6. **CPI depth:** `verify` runs one level below your program; your program must be at stack height 4 or lower
   with the current runtime limit.
7. **PDA agents:** use `invoke_signed` with the PDA's seeds.
8. **A mandate says what an owner allowed.** It is not an endorsement of the agent, and it does not replace the
   rest of your program's access control.

## Tests and measurements

Real `agent_auth.so` plus the fixture program in LiteSVM (`litesvm 0.12`):

```sh
export PATH="$HOME/.cargo/bin:$PATH"            # rustup cargo; Homebrew's breaks cargo build-sbf
crates/agent-auth-cpi/build-fixtures.sh         # builds agent_auth.so, fixture_caller.so, fixture_yes_man.so
cargo test -p agent-auth-cpi                    # unit tests, doc tests, 14 LiteSVM end-to-end tests
cargo test -p agent-auth-cpi --test e2e cu_overhead -- --nocapture   # prints the CU table
```

The programs are found through `AGENT_AUTH_SO`, `FIXTURE_CALLER_SO`, `FIXTURE_YES_MAN_SO`, or
`$CARGO_TARGET_DIR/deploy` (default `<repo>/target/deploy`). A missing `.so` fails the tests;
`AGENT_AUTH_ALLOW_SKIP=1` skips them.

End-to-end tests: happy path (funds move, counters bump); wrong program id (rejected before any CPI, with a
negative control where a naive integrator is drained); mandate owned by another program; wrong size and
discriminator; attacker-minted mandate (owner binding, with a negative control); owner account mismatch;
mandate for a different agent; agent not a signer; mandate not writable / already borrowed; expired,
per-transaction limit, lifetime limit, inactive, program or instruction not allowed (the core's error code
propagates); revoked mandate; PDA agent via `invoke_signed`; CU overhead. Each pre-CPI check was also
mutation-tested by hand: disabling any one of the seven checks makes at least one test fail.

CU (LiteSVM, one fixed state, second call so account loading is equal), from the `cu_overhead` test:

| instruction | CU |
|---|---|
| System transfer only, no verify | 1,552 |
| transfer + bare `verify` CPI (no checks) | 3,128 |
| transfer + `VerifyCpi::invoke` | 3,290 |
| **overhead of the helper's checks over a bare CPI** | **162** |

These are LiteSVM numbers, not mainnet measurements.

## Limits

* It cannot know whether the action you perform matches what you reported to `verify`. That is on the integrator.
* It does not derive the mandate PDA; it relies on the program-owner, size and discriminator checks, and only
  AgentAuth can create accounts it owns.
* Only the `verify` instruction (core tag `3`) is wrapped.
