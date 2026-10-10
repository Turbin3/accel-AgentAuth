# gated-example: a second integrator of AgentAuth

> Unaudited devnet prototype, test and demo only. Program id `CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ`
> (throwaway demo key).

## What it proves

AgentAuth is a standard that any program can enforce on its own instruction, not only through the relay.
This program is not the relay and has no special relationship with it. It has one gated instruction,
`gated_action(amount)`. The instruction cannot succeed unless AgentAuth `verify` approves
`(target = this program, disc8 = [1,0,0,0,0,0,0,0], amount)` for the calling agent: the program is its own
gate, so there is no other path to that action.

What it does not prove, stated plainly: `gated_action` only logs the amount, it moves nothing. A mandate check
inside an integrator is **advisory authorisation** (AgentAuth cannot see what the program does after `verify`
returns). Hard enforcement exists only in the relay's `transfer` and pinned `swap`. This example shows the
integration pattern and its failure modes, not custody.

## Instructions

| tag | name | data | accounts |
|---|---|---|---|
| `1` | `gated_action` | `[1] + amount u64 LE` | `[agent S, mandate W, owner R, agentauth_program R, config R]` (exactly 5) |
| `0` | `init` | `[0]` | `[authority S+W, config W, system R]`, once per deployment |

`disc8` of `gated_action` is `GATED_ACTION_DISC = [1,0,0,0,0,0,0,0]` (1-byte-tag rule: tag, then 7 zero bytes).
The config account is the PDA `["config"]` of this program (`Pubkey.findProgramAddress([b"config"], GATED_EXAMPLE_ID)`),
33 bytes: `expected_owner[32] | bump`. On success the program emits one program-data event:
`sol_log_data([b"gated_action", amount_le_bytes])`.

## The integration, in three steps

From `src/lib.rs`, using [`agent-auth-cpi`](../../crates/agent-auth-cpi/README.md):

```rust
// 1. who may grant mandates here: from OUR state, not from the transaction
let expected_owner = config::expected_owner(program_id, config)?;
// 2. ask AgentAuth: the crate pins the real program id and binds the mandate owner
VerifyCpi { agent_auth_program, mandate, owner, agent, expected_owner: &expected_owner,
            target_program: program_id, disc: GATED_ACTION_DISC, amount }.invoke()?;
// 3. act: exactly the verified amount
sol_log_data(&[b"gated_action", &amount.to_le_bytes()]);
```

Size: the gate (`gated_action` plus entrypoint, `src/lib.rs`) is 79 lines including docs. The config state
(`src/config.rs`, `init` and `expected_owner`) is another 67. Together 146 lines, so the original "under 100
lines" target holds for the gate but not for the whole crate once it carries its own safe state.

## Where `expected_owner` comes from, and why that is safe

Anyone can create a mandate that names any agent with *themselves* as owner. If the owner the mandate must carry
came from the transaction (an account or instruction data the caller picks), the attacker's own mandate would
pass. So the owner comes from **program state**: the config PDA.

* The account is owned by this program, sits at a fixed PDA address (`create_program_address(["config", bump])`
  must equal the account key), and has the exact size. A caller-chosen look-alike config (wrong address, or
  owned by another program) is rejected (`InvalidSeeds` / `InvalidAccountData`).
* Only `init` writes it, once: it calls System `Allocate`, which fails on a second call, and writes the signing
  `authority` as expected owner. Pre-funding the PDA with lamports does not block `init` (it tops up, then allocates).
* Instruction data cannot carry the owner: the crate checklist forbids it, and `gated_action`'s data is only
  the amount.

Honest limit: first `init` wins. Run it in the same script that deploys the program, and check the config
account contents afterwards. For an example that logs a number this is sufficient; a program that guards funds
should instead derive the owner from the vault it protects (see the crate's `fixture-caller`).

## Security checklist (from the crate), as applied here

1. `expected_owner` from own state: the config PDA (above).
2. Report the real amount and the real `(target_program, disc8)`: both come from the same variables used to act.
3. Verify first, act second, same instruction: `verify` precedes the log, no code path skips it.
4. AgentAuth program account and writable mandate in the account list: positions 3 and 1.
5. No borrow of the mandate across the call: the mandate is never borrowed by this program.
6. CPI depth: `verify` runs one level below this program; the crate requires this program to be at stack height 4 or lower.
7. PDA agents: not used here; `invoke_signed` exists for them.
8. A mandate is what an owner allowed, not an endorsement of the agent; this program has no other access control.

## Tests

`tests/gated.rs` runs the real `agent_auth.so` and `gated_example.so` in LiteSVM (21 tests):

```sh
export PATH="$HOME/.cargo/bin:$PATH"          # rustup cargo first (Homebrew cargo breaks build-sbf)
scripts/build-all.sh && source scripts/env.sh # builds agent_auth.so and gated_example.so into ./target/deploy
cargo test -p gated-example
cargo test -p gated-example compute_units -- --nocapture   # prints the CU
```

A missing `.so` is a hard failure (`AGENT_AUTH_ALLOW_SKIP=1` skips). Note that `target/deploy/agent_auth.so` must
be built from the current core source: the older binary lacks `set_active` (tag 5).

| test | scenario | result |
|---|---|---|
| GE-01 | `gated_action(4)`, then the boundary 10 (= per-tx) | success; slot `spend_total` 4 then 14, `call_count` 1 then 2; event logged |
| GE-02 | amount 11 > per-tx 10 | AgentAuth `Custom(8)`; mandate bytes unchanged |
| GE-03 | no permission; after `remove_permission`; permission for another program only | AgentAuth `Custom(6)` each |
| GE-04 | agent named but unsigned; another agent's key | `agent-auth-cpi` `AgentNotSigner` / `AgentMismatch`, before any CPI |
| GE-05 | AgentAuth binary at a different address passed as the program | `WrongAgentAuthProgram`, fake program never invoked |
| extra | attacker-minted mandate (attacker as owner, valid and approved by a bare `verify`) | `OwnerMismatch` |
| extra | owner account is not the configured owner | `OwnerAccountMismatch` |
| extra | expired / paused (and resumed) / revoked | `Custom(5)` / `Custom(4)` / `MandateNotOwnedByAgentAuth` (revoke closes the account) |
| extra | lifetime limit (exact remaining budget passes, +1 fails) | `Custom(9)`; unchanged on failure |
| extra | discriminator not allowed (other instruction listed) | `Custom(7)` |
| extra | not-writable mandate; system-owned look-alike mandate | `MandateNotWritable`; `MandateNotOwnedByAgentAuth` |
| extra | caller-chosen config; config not at the PDA; config owned by another program | rejected, mandate unchanged |
| extra | `init`: once only, needs a signature and the PDA address, survives pre-funding | as listed |
| extra | malformed data, too few / too many accounts | rejected |
| extra | two calls in one transaction, second over budget | whole transaction reverts, counters `(0, 0)` |

`agent-auth-cpi` errors are `Custom(0x4141_0001..)` and AgentAuth's are `Custom(1..=22)`: assertions check the code
and the failing program in the logs. Two of the planned matrix rows expect AgentAuth `Custom(18)` / `Custom(17)`
and the example's `Custom(1)`; because the helper refuses these cases before the CPI, the codes are the helper's
(see GE-04, GE-05 above).

Hand mutation check: using `owner.key()` as the expected owner fails the attacker and owner-account tests; removing the PDA
address check fails the caller-chosen-config test.

CU (LiteSVM, second call so account loading is equal, from `compute_units_are_recorded`): **3,872** for
`gated_action` including the `verify` CPI. LiteSVM, not mainnet.
