# Registry file format (schemaVersion 1)

One JSON file per program in `data/programs/<slug>.json`.

```jsonc
{
  "schemaVersion": 1,
  "slug": "spl-token",                       // kebab-case, equals the file name
  "name": "SPL Token",
  "kind": "native",                           // native | anchor | pinocchio | other
  "programIds": {                             // base58; omit a cluster if the program is not deployed there
    "mainnet-beta": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "devnet": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
  },
  "discriminatorScheme": "u8-tag",            // anchor-sha256 | u8-tag | u32le-tag | borsh-enum-u8 | custom
  "instructions": [
    {
      "name": "transfer_checked",             // snake_case, as in the IDL / source
      "title": "Transfer (checked)",          // short human label
      "disc8": "0c00000000000000",            // CANONICAL 8-byte discriminator, lowercase hex (16 chars)
      "rawPrefixHex": "0c",                   // the real leading bytes on the wire (1 byte tag => "0c", u32 => 4 bytes, Anchor => 8 bytes)
      "risk": "value_out",                    // see risk classes below
      "defaultDeny": false,                   // true for authority_change / account_close / admin
      "rationale": "Moves tokens out of an owner-controlled account.",   // <= 25 words
      "amount": { "offset": 1, "size": 8, "type": "u64le", "unit": "token_base_units" },  // offset in RAW instruction data; null if none
      "notes": ""
    }
  ],
  "sources": [ { "url": "https://...", "kind": "idl|docs|source", "ref": "commit sha, tag or version", "retrieved": "2026-10-10" } ],
  "verification": {
    "disc8RecomputedFromNames": true,         // true only if you recomputed every Anchor discriminator with scripts/disc.js
    "idlExplicitDiscriminatorsMatch": true,   // true if the IDL lists explicit discriminators and they equal yours; null if the IDL does not list them
    "onchainExecutable": { "mainnet-beta": true, "devnet": true },  // from a read-only `solana program show`; false/omitted if not checked
    "checkedAt": "2026-10-10"
  }
}
```

## Canonical `disc8` convention (this is the AgentAuth spec rule)

`disc8` is the 8-byte value an integrator reports to `AgentAuth.verify`.

* **Anchor programs:** the first 8 bytes of instruction data (`sha256("global:<snake_case_name>")[0..8]`).
* **1-byte-tag programs (SPL Token, Token-2022, ATA, Compute Budget):** the tag byte followed by 7 zero bytes. NEVER the first 8 raw bytes: for `transfer` those include the first 7 bytes of the amount.
* **u32-LE-tag programs (System, Stake):** the 4 tag bytes followed by 4 zero bytes.
* **Borsh-enum-u8 / custom programs:** document the rule in `notes`; use the tag byte zero-padded unless the program defines a longer discriminator.

## Risk classes

| risk | meaning | defaultDeny |
|---|---|---|
| `read_only` | no state change that affects owner funds (memo, compute budget, create ATA idempotent) | no |
| `value_out` | moves value out of an owner-controlled account to an address chosen by the caller | no (but needs limits) |
| `value_swap` | exchanges one asset for another; value can be lost to price manipulation | no (but needs limits + floor) |
| `position_mgmt` | opens/changes/closes DeFi positions (add/remove liquidity, deposit/withdraw to protocol) | no |
| `authority_change` | grants or transfers control (SetAuthority, Approve, delegate, owner reassign, multisig member changes) | **yes** |
| `account_close` | closes accounts / reclaims rent to an arbitrary address | **yes** |
| `admin` | upgrade, governance admin, parameter changes | **yes** |
| `other` | does not fit; explain in `notes` | decide per case |
