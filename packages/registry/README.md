# @agentauth-sol/registry

A dependency-free catalog of Solana instructions for AgentAuth mandates. A mandate allows an agent to call
specific `(program id, 8-byte instruction discriminator)` pairs with limits. This package lets tools:

* show a human-readable name for a `(programId, disc8)` pair,
* compute the canonical `disc8` from raw instruction data,
* flag dangerous instructions (authority changes, account closes, admin) as default-deny,
* read the amount from instruction data (for limits),
* build mandates from presets.

Plain ESM, Node >= 20, no runtime dependencies, hand-written `.d.ts`. The data is JSON in `data/programs/*.json`
(format: [SCHEMA.md](./SCHEMA.md)) and `data/presets/*.json`.

## Usage

```js
import {
  programs, getProgramById, getProgramBySlug, instructionByName,
  decodeInstruction, canonicalDisc8, riskOf, isDefaultDeny, parseAmount, presets, preset,
} from '@agentauth-sol/registry'

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const data = '0c40420f000000000006'              // hex string, Uint8Array or number[]

decodeInstruction(TOKEN, data)
// { known: true, program: {slug:'spl-token', ...}, instruction: {name:'transfer_checked', ...},
//   disc8: '0c00000000000000', risk: 'value_out', defaultDeny: false }

parseAmount(TOKEN, data)                          // 1000000n
canonicalDisc8(TOKEN, data)                       // '0c00000000000000'
riskOf(TOKEN, '0600000000000000')                 // 'authority_change' (set_authority)
isDefaultDeny(TOKEN, '0600000000000000')          // true
instructionByName('raydium-cpmm', 'swap_base_input').disc8   // '8fbe5adac41e33de'
preset('dex-trader-single-pool').permissions[0].instructions // resolved to disc8 values
```

Semantics worth knowing:

* `decodeInstruction` returns `known: false`, `risk: 'unknown'`, `defaultDeny: false` for an unlisted program or an
  unlisted instruction. `defaultDeny` means "the registry flags this as dangerous"; it is not an allowlist. A
  fail-closed integrator must deny anything with `known === false`.
* For an unlisted instruction in a listed program `disc8` is still computed by the convention below (or `null` if the
  data is too short, for example under 8 bytes for Anchor programs).
* Malformed input (odd-length hex, wrong type) throws `TypeError`.
* `riskOf` returns `null` and `isDefaultDeny` returns `false` for pairs not in the registry.
* `parseAmount` returns a `bigint`, or `null` when the instruction has no amount, is unknown, or the data is too short.
* Loaded data is deep-frozen.

## Canonical `disc8` convention

`disc8` is the 8-byte value an integrator reports to `AgentAuth.verify`. It is NOT always the first 8 data bytes: for
`transfer` those would include 7 bytes of the amount.

| Program kind | Wire discriminator | `disc8` |
|---|---|---|
| Anchor | first 8 bytes = `sha256("global:<snake_case_name>")[0..8]` | those 8 bytes |
| 1-byte tag (SPL Token, Token-2022, ATA, Compute Budget) | `[tag]` | tag byte + 7 zero bytes, e.g. `0c00000000000000` |
| Token-2022 extension instructions | `[tag, sub-tag]` | both bytes + 6 zeros, e.g. `1a01000000000000` |
| Token-2022 token-metadata / token-group (SPL interfaces) | 8 bytes, `sha256("<interface namespace>:<name>")[0..8]` | those 8 bytes |
| u32-LE tag (System, Stake) | 4 bytes | 4 tag bytes + 4 zero bytes, e.g. `0200000000000000` |
| Memo (no discriminator) | none, whole data is the UTF-8 memo | constant `0000000000000000` |

An unknown instruction in a program with a longer tag family follows the same rule (an unknown Token-2022 sub-tag still
reports tag + sub-tag). The ATA program treats EMPTY data as Create (legacy behaviour); the decoder follows that and
reports `create` with `0000000000000000`.

Recompute with `node scripts/disc.js anchor <name>` / `u8 <tag>` / `u32le <tag>`.

## Risk classes

| risk | meaning | defaultDeny |
|---|---|---|
| `read_only` | no state change that affects owner funds (memo, compute budget, create ATA idempotent) | no |
| `value_out` | moves value out of an owner-controlled account to a caller-chosen address | no, but needs limits (a few conservative exceptions are denied in the data) |
| `value_swap` | exchanges one asset for another; value can be lost to price manipulation | no, needs limits and an output floor |
| `position_mgmt` | opens/changes/closes DeFi positions | no |
| `authority_change` | grants or transfers control (set authority, approve, delegate, owner reassign) | **yes** |
| `account_close` | closes accounts / reclaims rent to an arbitrary address | **yes** |
| `admin` | upgrade, governance admin, parameter changes | **yes** |
| `other` | does not fit; see `notes` | per case |

The validator enforces: `authority_change`, `account_close` and `admin` must be `defaultDeny: true`; `read_only`,
`value_swap` and `position_mgmt` must be `false`. Risk and amount calls are judgement made from the cited sources, not
facts of the programs; treat them as conservative defaults, not guarantees.

## Scripts

* `npm test` runs `node --test test/*.test.js` (validator accepts all files, dozens of corruption mutations per file are
  rejected, decode round trips, amounts, every default-deny rule, presets). The glob is used because `node --test test/`
  does not work on Node 22+.
* `npm run verify` runs `scripts/verify-all.js`: validates every file and preset, and recomputes every Anchor
  discriminator (and every 1-byte / u32 tag `disc8`). Exit code 1 on any mismatch.

## Adding a program (checklist)

1. Find the primary source: the official IDL, the program or interface source at a pinned commit/tag, or official docs.
   Never copy discriminators from an explorer or a third-party list.
2. Create `data/programs/<slug>.json` per SCHEMA.md (slug equals file name, snake_case instruction names as in the IDL).
3. Anchor: set `disc8` and `rawPrefixHex` to `sha256("global:<name>")[0..8]`; check that explicit IDL discriminators
   (if the IDL has them) agree. Native: tag order from the source enum, not from memory.
4. Amount descriptors: `offset` is in RAW instruction data; verify against the serialization code.
5. Choose `risk` and `defaultDeny` for every instruction; every authority change, close and admin instruction must
   be `defaultDeny: true`. Rationale at most 25 words.
6. Record `sources` with a commit/tag/version, and `verification` (set `onchainExecutable` only from a real read-only
   `solana program show -u m|-u d`).
7. Run `npm run verify` and `npm test`; add decode and amount tests for the new program.
8. Update the coverage table below with an honest confidence level.

## Coverage and confidence

Counts are instructions in the file. Confidence is how much of the content was checked against primary sources.

| File | Instructions | Confidence | Notes |
|---|---|---|---|
| `system.json` | 14 | high | Tags, order and amount offsets match the system interface source. `create_account_with_seed` has no fixed amount offset (amount null). |
| `spl-token.json` | 28 | high | All tags and amount offsets match the interface source, including tags 38, 45 and 255 (batch). The file's wording about which crate version lacks tags 38/45/255 was not reconciled. `mint_to` is classed admin/deny, a conservative policy choice. |
| `spl-token-2022.json` | 100 | high (structure), medium (risk calls) | All 47 base tags plus 255 and the sub-tag order and count of all 15 extension enums match; token-metadata and token-group discriminators recomputed. Risk and rationale of the ~60 extension instructions were not individually reviewed. `initialize_mint` is read_only (policy choice). ELF-hash claims in notes not re-verified. |
| `associated-token-account.json` | 4 | medium | Tags 0-2 match the legacy program. Tag 3 `create_with_args` is p-ATA only and not deployed. The p-ATA wire format, SIMD-0567 status and dump-hash claims are not re-verified. |
| `memo.json` | 1 | medium | No discriminator; `disc8` is a registry convention. Only the Memo v3 id is registered; the other Memo ids named in the notes are NOT listed, so they decode as an unknown program. The legacy processor was not re-opened. |
| `compute-budget.json` | 5 | high | Tags and amount offsets match the interface source. Tag 0 `unused` is default-deny. |
| `stake.json` | 18 | high | Tags and amount offsets (4) match the stake interface source. |
| `orca-whirlpool.json` | 66 | high | Matches whirlpool 0.9.0 lib.rs and the 0.22.0 SDK IDL (66 explicit discriminators, no differences). |
| `raydium-cpmm.json` | 20 | high | Matches raydium-cp-swap master lib.rs; mainnet and devnet ids confirmed by `declare_id!`. No IDL is committed upstream, so discriminators are the Anchor default. |

On-chain executable status was re-checked this pass only for the Orca and Raydium ids; the other programs rely on the
earlier run.

Not covered: every other program (Jupiter, Meteora, Kamino, Marinade, Metaplex, Squads, ...), Token-2022 extension
data layouts beyond instruction amounts, and CPI-nested calls.

## License

MIT
