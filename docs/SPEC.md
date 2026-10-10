# AgentAuth Mandate Standard, version 1 (normative)

Status: specification of the on-chain behaviour of the `agent_auth` core program as built from this repository. Unaudited devnet prototype. The program id on devnet is `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if`; there is no mainnet deployment.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. When this document and the source disagree about the behaviour of the core program, the source (`src/`) wins and this document is a bug. The machine-readable interface is [`idl/core-idl.json`](../idl/core-idl.json); it is the source of truth for offsets and data layouts and is kept equal to the implementation.

This document specifies the **standard** (the mandate record and `verify`). It deliberately says little about enforcement: see section 9 for what `verify` does and does not guarantee, and [ARCHITECTURE.md](ARCHITECTURE.md) for the relay, the one component that turns the record into hard enforcement.

All integers are little-endian. Offsets are in bytes from the start of the account data or instruction data.

## 1. Model

A **mandate** is a program-owned account (a PDA of the core program) that records what one **agent** key may do on behalf of one **owner** key: a list of up to 16 **permissions**, each naming a target program, up to 8 allowed instruction discriminators (`disc8`, section 6), an optional per-call limit, an optional lifetime limit, and running counters; plus an **expiry** and an **active** flag. Only the owner mutates it. `verify` reads it, decides, and books the spend.

There is exactly one mandate per `(owner, agent)` pair: the address is `PDA(["mandate", owner, agent], AgentAuth)`.

## 2. Account layout

Account `AgentMandate`: owner = the AgentAuth program, `size = 2136` bytes (`88 + 16 * 128`), discriminator byte `1`. A reader MUST check owner program, exact size, and `data[0] == 1` before trusting any other field.

### 2.1 Header (88 bytes)

| Offset | Size | Field | Type | Meaning |
|---|---|---|---|---|
| 0 | 1 | `disc` | u8 | `1` once initialised |
| 1 | 32 | `owner` | pubkey | the only key that may mutate the mandate |
| 33 | 32 | `agent` | pubkey | the delegated key |
| 65 | 8 | `expiry` | i64 | unix seconds; the FIRST second at which the mandate is invalid |
| 73 | 1 | `active` | u8 | `1` active, `0` paused (`set_active`) |
| 74 | 3 | `pad0` | [u8;3] | zero |
| 77 | 2 | `permissions_len` | u16 | 0..=16 |
| 79 | 1 | `version` | u8 | `1` for accounts written by this release; `0` for accounts written by the pre-hardening v0.1 binary |
| 80 | 1 | `bump` | u8 | PDA bump, stored by `create_mandate` (meaningless when `version == 0`) |
| 81 | 7 | `pad1` | bytes | reserved, zero |

### 2.2 Permission slots (16 slots of 128 bytes, base offset 88)

Slot `i` starts at `88 + 128 * i`. Only the first `permissions_len` slots are meaningful; the rest MUST be zero.

| Slot offset | Size | Field | Type | Meaning |
|---|---|---|---|---|
| 0 | 32 | `program_id` | pubkey | target program |
| 32 | 8 | `spend_limit` | u64 | lifetime cap; `0` = unlimited |
| 40 | 8 | `per_tx_limit` | u64 | cap per `verify` call; `0` = unlimited |
| 48 | 8 | `spend_total` | u64 | running sum of verified amounts |
| 56 | 4 | `call_count` | u32 | number of verified calls |
| 60 | 1 | `discriminators_len` | u8 | 0..=8 |
| 61 | 3 | `pad` | [u8;3] | zero |
| 64 | 64 | `discriminators` | [[u8;8];8] | allowed `disc8` values; entries past `discriminators_len` are zero |

Constants: `MAX_PERMISSIONS = 16`, `MAX_DISCRIMINATORS = 8`, `ACCOUNT_SIZE = 2136`, `HEADER_SIZE = 88`, `PERMISSION_SIZE = 128`, mandate seed `b"mandate"`. They are pinned by `tests/layout.rs` against `fixtures/golden_mandate.bin`.

Rules:
* One permission per target program id. A second `add_permission` for the same program fails (21).
* `0` in `spend_limit` or `per_tx_limit` means UNLIMITED. This is a fail-open sentinel kept for layout compatibility; clients SHOULD require an explicit opt-in before writing `0`.
* Counters are keyed by the target program and are unit-less. All mints and decimals of the SPL Token program share one raw-unit counter. A hard per-asset budget needs the relay (which pins one mint) or one mandate per asset.
* There is no `created_at` or nonce. A mandate re-created after `revoke_mandate` for the same `(owner, agent)` has the same address.

## 3. Instructions

Instruction data starts with a one-byte tag. Every instruction requires its data length EXACTLY as listed; any other length returns 15. A missing account returns 15 (or the runtime's `NotEnoughAccountKeys` for `verify`).

| Tag | Name | Signer | Data (after tag) | Data length |
|---|---|---|---|---|
| 0 | `create_mandate` | owner | `expiry` i64 | 9 |
| 1 | `add_permission` | owner | `target_program[32] spend_limit u64 per_tx_limit u64 disc_len u8 discriminators[8*disc_len]` | `50 + 8*disc_len` |
| 2 | `remove_permission` | owner | `target_program[32]` | 33 |
| 3 | `verify` | agent | `target_program_id[32] disc8[8] amount u64` | 49 |
| 4 | `revoke_mandate` | owner | (none) | 1 |
| 5 | `set_active` | owner | `active u8` (0 or 1) | 2 |
| 6 | `update_permission` | owner | `target_program[32] spend_limit u64 per_tx_limit u64` | 49 |

Tags 0..4 are the original instruction set and their layouts are LOCKED. Tags 5 and 6 were appended in this release. An unknown tag returns 1.

### 3.1 Accounts

| Tag | Accounts (in order) |
|---|---|
| 0 `create_mandate` | `owner` (signer, writable, pays rent), `agent` (read; need not sign), `mandate` (writable, the PDA), `system_program` |
| 1 `add_permission` | `owner` (signer), `mandate` (writable) |
| 2 `remove_permission` | `owner` (signer), `mandate` (writable) |
| 3 `verify` | `mandate` (writable), `owner` (read; need not sign), `agent` (signer) |
| 4 `revoke_mandate` | `owner` (signer, writable; receives the lamports), `mandate` (writable), `system_program` (optional, ignored) |
| 5 `set_active` | `owner` (signer), `mandate` (writable) |
| 6 `update_permission` | `owner` (signer), `mandate` (writable) |

Extra trailing accounts are ignored.

### 3.2 Semantics

**`create_mandate(expiry)`.** MUST fail with 19 if `owner == agent`, 18 if the owner did not sign, 16 if the mandate address is not the canonical PDA, 20 if `expiry <= now`, 3 if a live mandate already exists, 14 if the address is owned by another program. A fresh address is created with `CreateAccount`; an address that was pre-funded with lamports is topped up to rent-exemption, assigned and grown (so pre-funding cannot block creation). Result: whole account zeroed, then `disc = 1`, `version = 1`, `bump`, `owner`, `agent`, `expiry`, `active = 1`, `permissions_len = 0`.

**`add_permission`.** Appends a slot with `spend_total = 0`, `call_count = 0`. Fails with 2 (not the owner), 4 (paused), 22 (`disc_len == 0`), 11 (`disc_len > 8`), 21 (duplicate program), 10 (already 16 permissions). An empty discriminator list is rejected because an empty list allows nothing.

**`remove_permission`.** Removes the WHOLE slot of that program (all its discriminators) by swap-remove: the last slot moves into the hole and the tail is zeroed. Fails with 12 if the program has no slot, 4 if paused. Removing and re-adding resets the counters.

**`update_permission`.** Replaces `spend_limit` and `per_tx_limit` of an existing slot. `spend_total`, `call_count` and the discriminator list are preserved: changing a limit does not grant a fresh budget. Lowering `spend_limit` below `spend_total` blocks the permission (9) until raised. On an UNLIMITED permission `spend_total` saturates at `u64::MAX`, so a finite limit set later also blocks it until remove and re-add. Fails with 12 if there is no slot, 4 if paused.

**`set_active(active)`.** Pause (`0`) or resume (`1`); any other value returns 15. Works on a paused mandate. While paused, `verify`, `add_permission`, `remove_permission` and `update_permission` return 4. Counters and permissions are preserved.

**`revoke_mandate`.** A real close: all lamports go to the owner, data is zeroed and shrunk to 0, and the account is assigned back to the System Program. Works on paused and on expired mandates. The PDA is verified with the stored bump (`version >= 1`); legacy `version == 0` mandates fall back to a bump search. After a revoke every instruction on that address returns 14 (not owned by AgentAuth), and the address can be re-funded and re-created.

**There is deliberately no instruction to change `expiry`.** To change a lifetime, revoke and create again.

## 4. `verify`

`verify` checks a REPORTED action against the mandate and books it. Data: `[3] + target_program_id[32] + disc8[8] + amount u64` (49 bytes). Accounts: `[mandate (W), owner (R), agent (S)]`.

### 4.1 Check order

An implementation MUST apply these checks in this order and return the listed error on the first failure; a failure aborts the enclosing transaction.

1. Data length exactly 48 bytes after the tag, else 15. Fewer than 3 accounts, `NotEnoughAccountKeys`.
2. `mandate` is owned by AgentAuth, else 14.
3. `mandate` is writable, else `InvalidAccountData`.
4. Size is 2136, `permissions_len <= 16` and `disc == 1`, else 16.
5. `active == 1`, else 4.
6. `now < expiry` (section 5), else 5.
7. `owner` account key equals `mandate.owner`, else 2.
8. `agent` account key equals `mandate.agent`, else 17.
9. `agent` is a signer, else 18.
10. A permission slot exists for `target_program_id`, else 6.
11. `disc8` is in that slot's list (an empty list allows nothing), else 7.
12. If `per_tx_limit != 0`: `amount <= per_tx_limit`, else 8.
13. If `spend_limit != 0`: `spend_total + amount <= spend_limit` with a checked add (overflow counts as over the limit), else 9.
14. Write back `spend_total += amount` and `call_count += 1`. On an unlimited permission both saturate, so `verify` never reverts because of counter overflow.

`verify` has no return value other than success; it signals denial by error. The `owner` account is compared, not required to sign.

### 4.2 What the booking means

`spend_total` is the sum of amounts that callers REPORTED and `verify` accepted. It is not an observation of funds moved (section 9).

## 5. Expiry

`expiry` is the first second at which the mandate is invalid: it is expired iff `now >= expiry`, where `now` is `Clock.unix_timestamp` read inside `verify`. `create_mandate` requires `expiry > now`. Mandates created by the pre-hardening v0.1 binary have `version == 0`, were not checked at creation, and may carry an expiry in the past.

## 6. Canonical `disc8`

`disc8` is the 8-byte instruction identifier that integrators report to `verify` and owners write into permissions. It is canonical so that an owner, an SDK and an integrator agree on the value without parsing instruction data:

| Program family | `disc8` | Example |
|---|---|---|
| Anchor | the first 8 bytes of instruction data, `sha256("global:<snake_case_name>")[0..8]` | Raydium CPMM `swap_base_input` = `8fbe5adac41e33de` |
| 1-byte tag (SPL Token, Token-2022, ATA, Compute Budget, native-style programs) | the tag byte followed by 7 zero bytes. NEVER the first 8 raw bytes: for `Transfer` those include 7 bytes of the amount | SPL Token `TransferChecked` (tag 12) = `0c00000000000000` |
| u32 little-endian tag (System, Stake) | the 4 tag bytes followed by 4 zero bytes | System `Transfer` (tag 2) = `0200000000000000` |
| Borsh enum / other | the program's tag zero-padded to 8 bytes unless the program defines a longer discriminator; document the rule | `gated-example` `gated_action` (tag 1) = `0100000000000000` |

The verified registry (`packages/registry`, field `disc8`) lists values for known programs and the sources they were derived from.

## 7. Errors

`ProgramError::Custom(code)`. Codes 1..18 are locked; new codes are appended.

| Code | Name | Raised when |
|---|---|---|
| 1 | InvalidDiscriminator | unknown instruction tag |
| 2 | NotOwner | the signing or passed owner is not `mandate.owner` |
| 3 | AlreadyInitialized | `create_mandate` on a live mandate |
| 4 | NotActive | mandate is paused |
| 5 | Expired | `verify` with `now >= expiry` |
| 6 | ProgramNotAllowed | no permission slot for the reported program |
| 7 | DiscriminatorNotAllowed | reported `disc8` not in the slot list |
| 8 | PerTxExceeded | `amount > per_tx_limit` |
| 9 | SpendLimitExceeded | `spend_total + amount > spend_limit` |
| 10 | PermissionsFull | 16 slots already used |
| 11 | TooManyDiscriminators | more than 8 discriminators in one permission |
| 12 | PermissionNotFound | `remove_permission` / `update_permission`: no slot |
| 13 | ArithmeticOverflow | checked add overflowed |
| 14 | AccountOwnerMismatch | the mandate account is not owned by AgentAuth (includes a revoked mandate) |
| 15 | InvalidInstructionData | wrong data length, or too few accounts |
| 16 | InvalidAccountType | `disc != 1`, size != 2136, corrupt header, or non-canonical PDA on create/revoke |
| 17 | UnknownAgent | `verify`: agent key is not `mandate.agent` |
| 18 | InvalidSigner | a required signature is missing (owner, or agent for `verify`) |
| 19 | InvalidAgent | `create_mandate`: owner equals agent |
| 20 | InvalidExpiry | `create_mandate`: expiry not in the future |
| 21 | DuplicatePermission | `add_permission`: slot for this program exists (use `update_permission`) |
| 22 | EmptyDiscriminators | `add_permission`: `disc_len == 0` |

Codes overlap across programs (the SPL Token program also returns small `Custom(n)`; the relay uses 100..119). Clients MUST attribute an error to the failing program id in the logs, not to the number alone.

## 8. Requirements on integrators

A program (or an off-chain service) that relies on a mandate:

1. MUST call the real AgentAuth program: hard-code `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` (or your own deployment's id) and MUST NOT accept the program id from the transaction. A caller-supplied "AgentAuth" can be a program that approves everything.
2. MUST bind `mandate.owner` to the authority it protects: pass an expected owner taken from its own state (a vault PDA seeded by the owner key, a stored authority) and reject any mandate whose `owner` differs. Anyone can create a mandate that names any agent with themselves as owner.
3. MUST derive `target_program_id`, `disc8` and `amount` from the action it is about to perform, from the same values it acts on. It MUST NOT treat a value reported by the caller as enforcement.
4. MUST call `verify` before performing the action, in the same instruction, and MUST NOT cache a past success.
5. MUST pass the mandate account writable and MUST NOT hold a borrow of its data across the CPI.
6. SHOULD account for CPI depth: `verify` runs one level below the caller.
7. SHOULD verify the action actually moved what it reported (the relay does this with exact balance deltas).
8. MUST NOT claim that a mandate prevents an action the integrator's own code does not gate.

The Rust crate [`crates/agent-auth-cpi`](../crates/agent-auth-cpi/README.md) implements 1, 2, 4 and 5 by construction. See [INTEGRATING.md](INTEGRATING.md).

## 9. What the standard does and does not guarantee

Guaranteed by the core program: only the owner can create or change a mandate; `verify` applies sections 4.1 and 5 to the values it is given, and books them atomically with the enclosing transaction; a failed `verify` reverts the transaction; a revoked mandate stops being a mandate.

Not guaranteed: that the caller reports the truth. `verify` cannot see what the calling program does next, and any program (or the agent itself, with a transaction of its own making) can call it with any values. Therefore **`verify` is advisory unless the integrator derives the reported values itself and makes the action conditional on the result.** In this repository hard enforcement exists in exactly two places: the relay `transfer` and the relay's pinned single-pool `swap`; and in programs that gate their own instruction correctly (`programs/gated-example` demonstrates the pattern, for a logged action that moves nothing).

An agent that holds the raw key of an asset can ignore a mandate entirely. A mandate constrains only what flows through an enforcement point.

## 10. Versioning

* The header `version` byte (offset 79) identifies the layout and semantics generation. This release writes `1`. A consumer MUST treat an unknown version as unsupported rather than guess. Accounts with `version == 0` come from the pre-hardening binary; clients SHOULD refuse them by default (the SDK does unless `acceptLegacyMandates` is set).
* The `verify` ABI (tag 3, 49 bytes, account order) and the error codes 1..18 are locked. Breaking changes require a new program id or a new `version`.
* Compatible additions: new instruction tags (next free tag is 7), new error codes (next free is 23), use of the reserved bytes below.
* The mandate address derivation (`["mandate", owner, agent]`) is part of the standard and is not versioned.

## 11. Extension points

* Reserved bytes that MUST be written as zero and MAY be given meaning by a later version: header `pad0` (74..77) and `pad1` (81..88); slot `pad` (61..64).
* New instruction tags >= 7.
* Layers on top of the standard that do not change it: the relay (separate program, own policy account), program-specific `disc8` rules (section 6), and the registry of known programs.
* Not extension points: the permission count (16), the discriminator count (8), the slot stride (128). Changing them changes the account size and is a new generation.

## 12. Conformance checklist

An implementation, client or integrator conforms to version 1 if all of the following hold. Items marked (I) apply to integrators only.

- [ ] Account decoding checks owner program, size 2136, `disc == 1` and `permissions_len <= 16` before reading fields.
- [ ] Offsets match section 2 exactly (golden fixture `fixtures/golden_mandate.bin`).
- [ ] The mandate address is `PDA(["mandate", owner, agent], AgentAuth)`.
- [ ] `verify` data is 49 bytes with accounts `[mandate W, owner R, agent S]`.
- [ ] Expiry is evaluated as `now >= expiry` means expired.
- [ ] `disc8` follows section 6, including the zero padding for tag-based programs.
- [ ] A limit of `0` is displayed as UNLIMITED and requires an explicit opt-in to write.
- [ ] Errors are attributed by failing program id, not by number alone.
- [ ] Revocation is treated as an account close (address owned by the System Program afterwards), pause as `active == 0`.
- [ ] (I) The AgentAuth program id is hard-coded.
- [ ] (I) `mandate.owner` is compared with an owner taken from the integrator's own state.
- [ ] (I) Program, `disc8` and amount are derived from the action performed.
- [ ] (I) The integrator does not describe its check as enforcement unless the action is conditional on it.

The repository's own conformance evidence: the core test suite (error matrix, model differential, fuzz, PoC regressions) and the LiteSVM end-to-end tests of `crates/agent-auth-cpi`; counts and measurements are in [BENCHMARKS.md](BENCHMARKS.md).
