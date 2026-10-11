# Integrating AgentAuth

AgentAuth is an unaudited devnet prototype. Read [SPEC.md](SPEC.md) section 8 and section 9 first: a mandate constrains only what flows through an enforcement point, and `verify` is advisory unless **your** code ties the action to its result.

Which section do you need?

| You are | Read |
|---|---|
| Writing an on-chain program that should refuse an agent that has no mandate | 1 (Pinocchio crate) or 2 (raw CPI from native or Anchor programs) |
| Building an agent or an agent framework that holds a key | 3 (SDK, MCP server, CLI) |
| Running an API or service that wants to know whether an agent is authorised | 4 |

Each snippet says how it was checked and when. Checks made by the 2026-10-11 conformance pass are labelled "compiled", "type-checked" or "run"; a statement that an earlier run happened and was not repeated is labelled "not re-run".

## 1. Program authors: Rust and Pinocchio with `agent-auth-cpi`

`crates/agent-auth-cpi` is a `no_std` crate with one dependency (Pinocchio). It is not published; use a path or git dependency.

```toml
[dependencies]
agent-auth-cpi = { path = "../agent-auth-cpi" }
```

### The three lines

```rust
use agent_auth_cpi::{disc8, VerifyCpi};

VerifyCpi {
    agent_auth_program: auth,        // account from the tx; the crate checks it against AGENT_AUTH_ID
    mandate, owner, agent,           // mandate (writable), owner (read), agent (signer)
    expected_owner: &vault_owner,    // from YOUR state, never from the caller
    target_program: &SYSTEM_PROGRAM, // what the agent is about to call
    disc: disc8::SYSTEM_TRANSFER,    // canonical 8-byte discriminator of that action
    amount: lamports,                // the REAL amount you are about to move
}
.invoke()?;
// verified: now perform exactly that action, out of the vault controlled by `vault_owner`
```

A complete program that does this (verify, then a System transfer out of the PDA `["treasury", expected_owner]`, with the expected owner read from a config account the program owns) is [`crates/agent-auth-cpi/tests/fixture-caller/src/lib.rs`](../crates/agent-auth-cpi/tests/fixture-caller/src/lib.rs); a smaller one is [`programs/gated-example`](../programs/gated-example/README.md). Both are built by `scripts/build-all.sh` and exercised against the real `agent_auth.so` in LiteSVM (`cargo test -p agent-auth-cpi`, 14 end-to-end tests listed in the crate README).

### What `invoke()` checks before it makes the CPI

1. the AgentAuth program account equals the compiled-in `AGENT_AUTH_ID`;
2. the mandate is owned by that program, is 2136 bytes, has discriminator `1`;
3. the mandate is writable and not already borrowed;
4. `mandate.owner == expected_owner` and the `owner` account is `expected_owner`;
5. `mandate.agent` is the `agent` account;
6. the agent signed (or `invoke_signed` supplies a PDA agent's seeds).

Then it calls `verify`; the core's own error code (`Custom(5)` expired, `Custom(8)` over the per-call cap, ...) propagates unchanged and a failing CPI aborts the whole transaction. The crate's own errors are `Custom(0x4141_0001 ..= 0x4141_000A)` and cannot collide with the core's 1..22.

### Why the crate pins the program id and binds the owner

These are the two confused-deputy holes that a hand-written `verify` call falls into.

* **Program id from the transaction.** If your program invokes whichever account the caller put in the "AgentAuth" slot, the caller supplies a program that returns success, and your check is approved by the attacker's own code. The crate always invokes the hard-coded id. The crate's LiteSVM end-to-end test for a wrong program id shows the rejection and, as a negative control, a naive integrator being drained.
* **Mandate owner not bound to the funds.** `create_mandate` is permissionless: anyone can make a mandate that names any agent with themselves as the owner. If you spend from a treasury that is not tied to the mandate's owner, the attacker's own mandate authorises spending someone else's money. `expected_owner` is a required field, and the checklist says to take it from your own state and to make the funds follow it (sign for a PDA derived from that same owner). The end-to-end test for an attacker-minted mandate has the same negative control.

### Security checklist

1. `expected_owner` comes from your program state (a vault PDA seeded by the owner key, a stored authority field); never from instruction data or an account the agent picks.
2. Report the real amount and the real `(target_program, disc8)`, computed from the values you act on. Do not take a separate "amount to verify" from the caller. `verify` cannot see what you do afterwards: this is advisory authorisation of an action that **you** perform.
3. Verify first, act second, in the same instruction. No cached approvals; no code path that moves value without it.
4. Put the AgentAuth program account and a writable mandate in your instruction's account list.
5. Do not hold a borrow of the mandate data across the call (the crate reports `MandateBorrowed`).
6. CPI depth: `verify` runs one level below you; you must be at stack height 4 or lower.
7. PDA agents: use `invoke_signed` with the PDA's seeds.
8. A mandate says what an owner allowed. It is not an endorsement of the agent and it does not replace the rest of your access control.

Cost: the crate's checks add 162 CU over a bare `verify` CPI (`cargo test -p agent-auth-cpi --test e2e cu_overhead -- --nocapture`; System transfer alone 1,552 CU, transfer plus the helper 3,290 CU; LiteSVM).

### Computing `disc8`

* 1-byte-tag programs (SPL Token, Token-2022): `disc8::from_u8_tag(12)` (tag, then 7 zero bytes). Never the first 8 raw instruction bytes: for `Transfer` they contain part of the amount.
* u32-LE-tag programs (System, Stake): `disc8::from_u32_tag(2)`.
* Anchor programs: the first 8 bytes of instruction data, `sha256("global:<snake_case_name>")[..8]`. In a `no_std` const context, precompute: `printf 'global:swap_base_input' | shasum -a 256 | cut -c1-16` prints `8fbe5adac41e33de`, then `const SWAP: [u8; 8] = disc8::from_prefix(&[0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde]);`.

The registry (`packages/registry`, field `disc8`) lists verified values for known programs.

## 2. Native and Anchor programs: raw CPI

If you cannot use the Pinocchio crate you build the `verify` instruction yourself. You then own both traps of section 1: hard-code the id and bind the owner.

Wire format (`idl/core-idl.json`, tag 3, locked):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | tag `3` |
| 1 | 32 | `target_program_id` |
| 33 | 8 | `disc8` |
| 41 | 8 | `amount` u64 little-endian |

Total 49 bytes. Accounts in order: `mandate` (writable), `owner` (readonly), `agent` (readonly, **signer**). The agent must sign: `verify` is not a permissionless call, and the agent's signature on your outer instruction extends to the CPI without signer seeds.

```rust
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::{pubkey, Pubkey};

/// The only AgentAuth program id your program may call. Hard-code it; never take it from the transaction.
pub const AGENT_AUTH_ID: Pubkey = pubkey!("AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if");

/// Canonical disc8 for a 1-byte-tag program: the tag, then 7 zero bytes.
pub const fn disc8_u8_tag(tag: u8) -> [u8; 8] { [tag, 0, 0, 0, 0, 0, 0, 0] }

pub fn verify_ix(mandate: Pubkey, owner: Pubkey, agent: Pubkey, target: Pubkey, disc: [u8; 8], amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(49);
    data.push(3);
    data.extend_from_slice(target.as_ref());
    data.extend_from_slice(&disc);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: AGENT_AUTH_ID,
        accounts: vec![
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(agent, true),
        ],
        data,
    }
}
```

Compiled and tested on 2026-10-11 in a scratch crate with `solana-instruction = "4"` and `solana-pubkey = "4"` (cargo resolved 4.0.0 and 4.4.0; `solana-instruction 4.0.0` requires `solana-pubkey >= 4.3.0`, so a pin of `solana-pubkey =4.2.0` does not resolve): a unit test asserts length 49, tag 3, the target at 1..33, `[12,0,0,0,0,0,0,0]` at 33..41 and the amount at 41..49. The `invoke` call itself (`solana_program::program::invoke(&verify_ix(...), &[mandate, owner, agent, agent_auth_program])`) is the standard one and was not compiled here. Before it, in your program, you MUST:

1. check that the AgentAuth program account passed in equals `AGENT_AUTH_ID` (or do not take it from the caller at all);
2. read the mandate account's data: owner program must be `AGENT_AUTH_ID`, length 2136, `data[0] == 1`, and bytes `1..33` (the mandate `owner`) must equal the owner your own state says controls the funds; bytes `33..65` must equal the agent that signed;
3. build `target`, `disc` and `amount` from the action you are about to perform.

Anchor notes: add `agent_auth_program`, `mandate` (`#[account(mut)]`), `owner` and `agent` (`Signer`) to the `Accounts` struct, use `UncheckedAccount` plus the manual checks above for the mandate (there is no Anchor IDL type for it), and read your own gated action's `disc8` as the first 8 bytes of the instruction data Anchor generated for it.

## 3. Agent frameworks

The agent holds only its own key (fee SOL, no token authority). The owner sets up the mandate; the agent pays through the relay.

### TypeScript SDK (`@agentauth-sol/sdk`, not published; build from this repo)

```ts
import type { Address, KeyPairSigner } from '@solana/kit'
import { createClient, mandatePda, preflightFailureToError, relayTransferIx } from '@agentauth-sol/sdk'

export async function pay(owner: Address, agent: KeyPairSigner, destination: Address) {
  const client = createClient({ cluster: 'devnet' }) // 'localnet' with rpcUrl for tests
  // pre-flight against live chain data and the cluster clock: no transaction, no fee
  const pre = await client.preflightTransfer({ owner, agent: agent.address, destination, amount: 2_000_000n })
  if (!pre.ok) { const e = preflightFailureToError(pre); console.log(e.program, e.name, e.code); return }
  const mandate = (await mandatePda(owner, agent.address)).address
  const policy = await client.fetchPolicy(mandate)
  if (!policy) throw new Error('no relay policy')
  const ix = await relayTransferIx({ agent, policy, destination, amount: 2_000_000n })
  const res = await client.sendAndConfirm([ix], { signers: [agent], computeUnitLimit: 200_000 })
  return res.signature
}
```

Type-checked on 2026-10-11 with `tsc --noEmit` (strict, the repository's base config) against `packages/sdk/dist/index.d.ts`. An earlier run against a local validator with the demo environment (recorded in [DEMO.md](DEMO.md), not re-run in the conformance pass): a 2 DUSD payment to the allowlisted account was sent; the same call to a non-allowlisted account returned `relay RecipientNotAllowed 104` from the pre-flight and nothing was sent. `owner` is the owner you trust (never read it from a request); the same recipe is type-checked in `packages/sdk/test/recipes.ts` (`pnpm --filter @agentauth-sol/sdk test`, `recipes.test.ts` and `surface.test.ts` pass: 79 tests on 2026-10-11). See [`packages/sdk/README.md`](../packages/sdk/README.md) and `API.md`.

### MCP server (`@agentauth-sol/mcp`)

Three profiles with separate trust: `agent` (holds only the agent key; tools `agentauth_status`, `agentauth_check_action`, `agentauth_pay`, `agentauth_explain_denial`, `agentauth_activity`, and `agentauth_swap` when the policy enables swaps), `owner` (no key; builds **unsigned** plans for the human's wallet), `observer` (read only). An agent process refuses to start if the owner keypair variable is in its environment. Claude Code:

```sh
pnpm --filter @agentauth-sol/mcp build        # builds packages/mcp/dist/bin.js; on 2026-10-11 `node packages/mcp/dist/bin.js --help` printed the usage
claude mcp add agentauth -e AGENTAUTH_AGENT_KEYPAIR=$HOME/.config/agentauth/agent.json \
  -- node /ABS/PATH/packages/mcp/dist/bin.js --profile agent --cluster devnet --owner <OWNER_WALLET>
```

Details, the threat model of an MCP wallet tool and the Claude Desktop config are in [`packages/mcp/README.md`](../packages/mcp/README.md). The model does not choose the owner, the program or the recipient: they come from the server's configuration and the on-chain policy.

### CLI (`agentauth`)

```sh
pnpm --filter @agentauth-sol/cli build
agentauth doctor                                   # node, RPC, the four programs, keypairs, balances
agentauth lint payments-usdc                       # lint a preset or your plan; no chain, no keys
agentauth mandate create --preset payments-usdc --per-call "5 DUSD" --budget "20 DUSD" \
  --delegate "50 DUSD" --allow-override --recipient @recipientDusd --yes
agentauth relay pay --to @recipientDusd --amount "3 DUSD"       # the agent key signs
agentauth permission remove spl-token --yes        # agent now gets agent_auth:6 ProgramNotAllowed
agentauth activity                                 # ok rows and BLOCKED attempts, decoded
agentauth mandate revoke --yes                     # one-transaction unwind
```

The flags above were checked against `agentauth mandate create --help` on 2026-10-11. The end-to-end tour against a local validator was run earlier and is quoted in the CLI README (not re-run in the conformance pass). Every preview lists WARNINGS first and labels each capability HARD (relay) or ADVISORY. Exit codes: 2 pre-flight denial, 3 landed and failed on chain.

### Cooperative guard (`@agentauth-sol/guard`)

A client-side check in the agent's own process. It stops an honest or confused agent stack from signing something its mandate does not cover; anyone holding the raw key can bypass it. It is not enforcement.

## 4. API sellers and other read-only consumers

If you only need to know "is this agent authorised, by an owner I trust, for this program and instruction and amount", read the mandate off-chain:

```ts
import { address } from '@solana/kit'
import { assertMandateAuthorises, createClient, TOKEN_PROGRAM_ID, TRANSFER_CHECKED_DISC } from '@agentauth-sol/sdk'

const client = createClient({ cluster: 'devnet' })
const owner = address('...')  // the owner YOU trust, from your own records; never from the request
const agent = address('...')  // the agent that signed your request
const { mandate } = await client.fetchMandateFor(owner, agent) // read-only, no keys
const r = assertMandateAuthorises(mandate, {
  expectedOwner: owner, agent, targetProgram: TOKEN_PROGRAM_ID,
  discriminator: TRANSFER_CHECKED_DISC, amount: 3_000_000n, now: BigInt(Math.floor(Date.now() / 1000)),
})
if (!r.ok) throw r.error // r.error.program, r.error.name, r.error.code
```

The snippet was type-checked against `dist` on 2026-10-11. Run offline on 2026-10-11 against `fixtures/golden_mandate_v1.bin` (per-call cap 50,000, owner bytes `01`*32, agent `02`*32, target `AA`*32, `disc8` `0102030405060708`, `now` 1,800,000,000): amount 50,000 returned ok (advisory), 50,001 returned `agent_auth PerTxExceeded 8`, and a different `expectedOwner` returned `agent_auth NotOwner 2`.

This check is **advisory**. It is an off-chain read: it cannot reserve budget (two sellers can both pass and the second on-chain `verify` can still fail), and it does not stop the agent from doing anything. `expectedOwner` is required on purpose: a mandate created by a stranger for the agent verifies fine against itself. If you need enforcement, make the action an instruction of an on-chain program that calls `verify` (section 1 or 2), or accept payment only through the relay.

## 5. Common mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| Taking the AgentAuth program id from the transaction | a yes-man program approves everything | hard-code it; use `agent-auth-cpi` |
| Not comparing `mandate.owner` with the authority you protect | an attacker-minted mandate authorises spending someone else's funds | `expected_owner` from your own state |
| Reporting an amount or discriminator the caller chose | the check proves nothing about what happens next | derive both from the action you perform |
| Calling `verify` and then not conditioning the action on it | advisory only | do the action in the same instruction, after `verify` |
| Treating `0` limits as "none" in a UI | `0` means unlimited | show UNLIMITED and require an opt-in |
| Computing `disc8` from the first 8 raw bytes of a 1-byte-tag instruction | wrong value, includes part of the amount | tag byte plus 7 zero bytes |
| Mixing mints under one SPL Token permission | one raw-unit counter shared by all mints | one mandate per asset, or use the relay (pins one mint) |
