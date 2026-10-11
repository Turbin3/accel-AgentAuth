# Putting the hardened programs on devnet (runbook)

AgentAuth is an unaudited devnet prototype. This document is a runbook for the project owner. **Nothing in the repository deploys anything on its own.** `scripts/devnet-deploy.sh` is a dry run by default: it reads, checks and prints the exact commands. It sends transactions only with `--execute` and an interactive typed confirmation, and it makes a program non-upgradeable only with `--burn-authority` and a second typed confirmation.

State of devnet, read-only, 2026-10-11 (`solana program show <id> -u devnet`):

| Program | Id | On devnet | Details |
|---|---|---|---|
| core `agent_auth` | `AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if` | yes, upgradeable | ProgramData `CFRWSrkwycjM1Q759E7dStLeFHeVFWNjrXtFvLhhMXYi`, upgrade authority `8SRwaR9wr4n7a3tCWMgejAV5DAJnky8NXQTS8qWgsEyC`, last deployed in slot 471094128, data length 50,032 B, balance 0.3494268 SOL |
| `agent_auth_relay` | `33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6` | no account | |
| `mock_amm` | `6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw` | no account | |
| `gated_example` | `CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ` | no account | |

The on-chain core program's first 36,472 bytes hash to `957603806012...c358aa`, the current build to `1e459e348907...c09bc`: they differ, so an upgrade would change the program (see section 2).

## 0. Before anything

1. Build from a clean tree: `export PATH="$HOME/.cargo/bin:$PATH"; scripts/build-all.sh`. It prints the sha256 and size of every `.so`. On 2026-10-11 (this tree): `agent_auth.so` 36,472 B `1e459e34...09bc`; `agent_auth_relay.so` 64,032 B `ed6b884c...ea4f`; `mock_amm.so` 42,600 B; `gated_example.so` 25,904 B. The localnet relay (`deploy-localnet/agent_auth_relay.so`, 64,104 B) is a different file.
2. **Back up the program keypairs** `keys/agent_auth_relay-keypair.json`, `keys/mock_amm-keypair.json`, `keys/gated_example-keypair.json` (they are gitignored, so a fresh clone has none and the dry run prints a WARN for each missing keypair). They define the program ids. The keypair file is needed only for the first deploy of an id, but losing it loses the ability to ever redeploy that id if the program is closed, and the ids are baked into the SDK, the CLI, the IDL and the relay. Keep copies offline. Never commit or paste them.
3. The core program has **no keypair in `keys/`**. It already exists on devnet and is upgraded by id; the signer you need is its upgrade authority.
4. Fund the payer on devnet. `solana rent` (run by the dry run) gives the rent-exempt minimum for each programdata account: about 0.186 SOL for the core, 0.326 SOL for the relay, 0.217 SOL for the mock AMM and 0.132 SOL for gated-example (2026-10-11). A deploy writes through a temporary buffer account, so the peak need is roughly twice the figure for a first deploy; the buffer's rent is refunded. Devnet faucet limits are small and rate limited (check the current limits; use the web faucet or a funded wallet if `solana airdrop` is refused).
5. Use a dedicated devnet RPC for the real run and for any recording; the public endpoint rate limits.
6. Re-check cluster feature status right before quoting any depth or CU claim: `solana feature status -u devnet`.

## 1. Run the dry run

```sh
scripts/devnet-deploy.sh --programs core,relay,mock_amm,gated_example
# with the right signers:
scripts/devnet-deploy.sh --programs core,relay --upgrade-authority /path/to/core-authority.json --payer /path/to/payer.json
```

What it does (all read-only): prints `solana config`, the payer and authority **addresses** and devnet balances (it asks the solana CLI for the address, and it never reads, copies or prints a keypair file); checks that each `.so` exists and prints size and sha256; checks that each program id equals the address of `keys/<name>-keypair.json`; runs `solana program show` for each id; runs `solana program dump` and compares the sha256 of the on-chain program (first N bytes, N = local size) with the local build; refuses if `deploy/agent_auth_relay.so` is byte-identical to the test-amm localnet build; then prints the deploy commands, the verification commands and the burn commands.

Dry run on 2026-10-11 (abridged; full output in the team's scratch log):

```
== on-chain state (read-only: solana program show / dump)
-- core AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if
     Authority: 8SRwaR9wr4n7a3tCWMgejAV5DAJnky8NXQTS8qWgsEyC
     Data Length: 50032 (0xc370) bytes
     on-chain sha256 (first 36472 B): 957603806012086687c856e3ef18da163539fd4baffc3469cb520d17cac358aa
     local    sha256:                     1e459e348907adf0c5b5d3606cfc00324de7628ca0cb6e550547413d6cfc09bc
     DIFFERENT: a deploy would change the on-chain program
-- relay 33Vpe...: not deployed on this cluster
ok:   relay  keys file address == 33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6
ok:   mock_amm  keys file address == 6QhMSWnMsDQKBPswWHpYdtXEDLyRzv3S5BnDBH2M2vLw
ok:   gated_example  keys file address == CoXCzcw7MfX6N7kPQJYhJNdGetovatuPq6xo39pHBQLZ
WARN: core: no --upgrade-authority given; the payer will be tried as the authority
== commands that would run (deploy)
  solana -u https://api.devnet.solana.com program deploy .../agent_auth.so --program-id AKkih5Yd...Uc2if --keypair <payer>
  solana -u https://api.devnet.solana.com program deploy .../agent_auth_relay.so --program-id keys/agent_auth_relay-keypair.json --keypair <payer>
DRY RUN complete. Nothing was sent, no key was read or printed.
```

The guard rails were also exercised: `--burn-authority` without `--execute` is refused; `--execute` without a terminal is refused ("Nothing was sent"); a mainnet RPC is refused. `--execute` was not run.

## 2. Upgrading the existing core program

The upgrade needs the **current upgrade-authority keypair**. The authority observed by read-only RPC is `8SRwaR9wr4n7a3tCWMgejAV5DAJnky8NXQTS8qWgsEyC`; whoever deploys must hold the key for it (who holds it is not known to this documentation). If it is lost the program cannot be upgraded and the hardened core can only go to a new program id, which would change the id baked into every client.

```sh
# 1. keep the CURRENT on-chain binary so you can roll back while you still hold the authority
solana program dump AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if backup-core-pre-upgrade.so -u devnet
sha256sum backup-core-pre-upgrade.so

# 2. dry run, then the real thing
scripts/devnet-deploy.sh --programs core --upgrade-authority /path/to/authority.json --payer /path/to/payer.json
scripts/devnet-deploy.sh --programs core --upgrade-authority /path/to/authority.json --payer /path/to/payer.json --execute
```

The command it runs is `solana program deploy <agent_auth.so> --program-id AKkih5Y... --keypair <payer> --upgrade-authority <authority>`. The new binary (36,472 B) is smaller than the existing ProgramData allocation (50,032 B), so no extension is needed.

**What changes for existing devnet users.** At review time no live mandates existed on the devnet program (from the review package; confirm with `getProgramAccounts` filtered by size 2136 before you upgrade, as the review is a snapshot). The ABI and layout are locked, so a client written against the old binary keeps working: instruction tags 0..4, the `verify` data and the 2136-byte account are unchanged. What does change behaviourally, per `idl/core-idl.json`:

* `revoke_mandate` now performs a real close (all lamports to the owner, data shrunk to 0, account assigned back to the System Program), and `active = 0` now means paused, not revoked;
* `create_mandate` rejects `owner == agent` (19) and an expiry in the past (20), tolerates a pre-funded address, and stores a version byte and the PDA bump;
* `add_permission` rejects an empty discriminator list (22) and duplicate programs (21); `verify` saturates counters on unlimited permissions;
* new instructions: `set_active` (5) and `update_permission` (6).

A mandate created by the old binary has `version == 0` and no stored bump; `revoke_mandate` falls back to a bump search for it, and the SDK refuses such mandates unless `acceptLegacyMandates` is set. Its expiry may be in the past.

Rollback: while you hold the authority you can re-deploy the dumped binary the same way. Once the authority is burned (section 6) you cannot.

## 3. Deploying the relay (and the optional demo programs)

```sh
scripts/devnet-deploy.sh --programs relay --payer /path/to/payer.json            # dry run
scripts/devnet-deploy.sh --programs relay --payer /path/to/payer.json --execute
```

* The relay deploys from `target/deploy/agent_auth_relay.so`, built with the **default features** (`devnet`): its AMM allowlist is the Raydium CPMM **devnet** program `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` only. Whether a usable Raydium CPMM pool exists on devnet, and the CU of a swap against the real binary, have not been checked: the relay's tests and the demo swap use the mock AMM. Do not describe the swap as working against Raydium until you have run it.
* **The `test-amm` build (`target/deploy-localnet/agent_auth_relay.so`) must not be deployed to the relay id.** It additionally allowlists the mock AMM, which has adversarial test modes; an owner (or a careless UI) could then pin a hostile pool in a policy, and the statement "the relay only talks to a real AMM" would no longer hold. The trade-off: a devnet demo of the swap beat needs the mock AMM, which needs that build. If you want it, do it as a clearly labelled demo on its **own** program id: generate a new keypair, deploy the test-amm build to it (the relay uses the runtime program id for its PDAs, so the same binary works at any id), deploy `mock_amm`, and point the SDK at it with `createClient({ cluster: 'devnet', programIds: { relay: <demo relay id>, mockAmm: ... } })`. The `apps/demo` scripts were not written for such overrides and have not been run that way. `devnet-deploy.sh` deliberately only handles the production relay build and refuses the test-amm binary.
* `mock_amm` and `gated_example` are optional and for demos only (`--programs relay,mock_amm,gated_example`). `gated_example` needs its one-time `init` instruction (tag 0, accounts `[authority S+W, config W, system]`) to record whose mandates it honours; the demo `bootstrap` does this on localnet.
* Upgrade authority: a first deploy sets it to the payer (or to `--upgrade-authority`). See section 6 before deciding what to do with it.

Verify: `solana program show 33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6 -u devnet` must show your authority, a data length close to 64,032 B and the slot you just deployed in.

## 4. Re-running the demo against devnet instead of localnet

Be clear about what works. The demo tooling (`apps/demo`) is a localnet tool:

* `bootstrap` creates its own mints (DUSD, DOUT), a mock pool, and airdrops up to 100 SOL to each cast member. The devnet faucet will not give that, and the mock-AMM pool needs the test-amm relay (section 3). The runners also refuse a non-loopback RPC unless `AA_ALLOW_REMOTE=1`.
* `contrast` and `scenario` assert a swap on the mock pool. Against the production relay (Raydium-only allowlist) the swap beats fail with relay 103, by design. These are not expected to pass on devnet as they are.

A suggested sequence for a devnet recording (not run):

1. Cast: your own funded owner, a fresh agent keypair (fee SOL only), a recipient token account.
2. Mint: the devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (read-only `solana account` shows it exists and is owned by the Token program; it is in the registry's mint table; get test USDC from Circle's devnet faucet), or create your own mint.
3. `agentauth --cluster devnet mandate create ...` with `--recipient <token account>` and no swap, then `agentauth relay pay`, `permission remove`, `activity`, `mandate revoke`. These use the production relay and the pre-flight shows the same decoded errors as on localnet.
4. Rate limits: use a dedicated RPC; a failed attempt still pays its fee, so keep the agent funded with a little SOL.

## 5. Verification and what to screenshot

```sh
solana program show AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if -u devnet
solana program show 33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6 -u devnet
solana program dump AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if /tmp/onchain-core.so -u devnet
head -c 36472 /tmp/onchain-core.so | sha256sum        # must equal the sha256 printed by build-all.sh
```

Screenshot for the video: the `solana program show` output (Program Id, ProgramData Address, **Authority**, Last Deployed In Slot, Data Length) for each program, and the matching sha256 lines. If the authority line reads a key, say "upgradeable by <key>", not "immutable". Only an `Authority: none` line justifies the word immutable.

## 6. Burning the upgrade authority versus a multisig

| | Burn (`solana program set-upgrade-authority <id> --final`) | Multisig upgrade authority (`--new-upgrade-authority <multisig vault>`) |
|---|---|---|
| Effect | the program can never be changed; `Authority: none` | upgrades need the multisig threshold |
| Good for | a credibility statement on a demo deployment: nobody, including us, can swap the code | fixing bugs after the audit-style review; staged rollout |
| Cost | **irreversible.** A bug found later cannot be fixed in place; the fix needs a new program id, and every client, IDL and doc that bakes in the id must change. Anyone with an open mandate or policy is stranded on the buggy code | the multisig and its signers are now the trust root; a compromised quorum can replace the code |
| Closing the program | impossible after a burn (no authority) | the authority can close the program and reclaim rent |

Honest consequences: while any authority key exists, the claim is "upgradeable by <key>". A burned authority does not make the program correct, it only makes it unchangeable; the programs are unaudited. Burning the core is a bigger decision than burning the relay, because the relay depends on the core's ABI. Do not burn before the video flows you intend to show have been run on the deployed bytes. The script burns only with `--execute --burn-authority`, prints a boxed warning, requires the exact phrase `burn upgrade authority forever`, and finishes by showing `solana program show` so you can screenshot `Authority: none`.

## 7. Command reference of the script

```
scripts/devnet-deploy.sh [--programs core,relay,mock_amm,gated_example] [--upgrade-authority PATH] [--payer PATH]
                         [--rpc URL] [--target-dir DIR] [--keys-dir DIR] [--execute] [--burn-authority]
```

Default programs: `core,relay`. Default RPC: `https://api.devnet.solana.com`; anything that does not look like devnet (or loopback) is refused, and so is any URL containing `mainnet`. `--execute` needs a terminal and the typed phrase `deploy to devnet`. The script is bash-3.2 compatible and was syntax-checked with `bash -n`; `shellcheck` was not available on this machine.
