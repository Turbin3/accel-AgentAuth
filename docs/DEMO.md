# Demo guide

AgentAuth is an **unaudited devnet prototype**. Everything below ran on a **local validator** (`solana-test-validator`) with a **mock AMM** and mock funds (DUSD, "Demo Dollar"). Hard enforcement exists only for the relay `transfer` and the pinned `swap`; everything else a mandate lists is advisory unless the integrating program calls `verify`. The attacker (MALLORY, the "compromised agent") is a **script**, labelled as such on every beat; the prompt injection is planted text, not a discovered vulnerability of any model.

Framing line: **"We do not stop the prompt injection. We cap what a fooled agent can do, on-chain."**

Real, unedited transcripts (ANSI colour and blank lines stripped, nothing else removed) are in [docs/transcripts/](transcripts/): [contrast.txt](transcripts/contrast.txt), [scenario.txt](transcripts/scenario.txt), [attacks.txt](transcripts/attacks.txt). Each starts with the exact command, date, environment and exit code. They are not pasted here.

## 1. Run it

```sh
export PATH="$HOME/.cargo/bin:$PATH"
scripts/build-all.sh                              # once: programs -> target/deploy, target/deploy-localnet
scripts/localnet.sh start                         # AA_LOCALNET_INSTANCE=<0-9> for a parallel validator
eval "$(scripts/localnet.sh env)"                 # AA_RPC_URL, AA_WS_URL, AA_DEMO_DIR
pnpm --filter @agentauth-sol/demo bootstrap

pnpm --filter @agentauth-sol/demo contrast        # same injection: hot-wallet agent vs mandate agent
pnpm --filter @agentauth-sol/demo scenario        # the full beat sequence, expected errors asserted
pnpm --filter @agentauth-sol/demo attacks         # 54 scripted attacks, result table
```

Flags on all three: `--fast` (no pauses), `--json` (only the JSON transcript on stdout), `--pause <ms>`, `--transcript <file>`. Exit code 1 on any deviation. For a recording, run without `--fast`: each beat waits so the audience can read.

The localnet relay is the `test-amm` build (it allowlists the mock AMM). It must never be deployed; the devnet relay build does not allowlist the mock AMM.

Measured on 2026-10-11 with `--fast`, localnet instance 6, fresh ledger (`scripts/localnet.sh start` wipes it, then `bootstrap`). Every run below exited 0 and printed `PASSED`.

| script | fresh ledger | second pass, same ledger | transactions | transcript |
|---|---|---|---|---|
| `contrast` | 6 s | 6 s | 9 | [contrast.txt](transcripts/contrast.txt) |
| `scenario` | 23 s | 21 s | 34 | [scenario.txt](transcripts/scenario.txt) |
| `attacks` | 47 s | 47 s | 70 (54 attacks) | [attacks.txt](transcripts/attacks.txt) |

Order actually run: `contrast`, `scenario` (fresh), `scenario --json` (also passed, 707 lines, about 33 KB, not committed), `attacks` twice, `contrast` and `scenario` again. Transcripts are from the later passes, so balances such as the owner's DUSD (952 at the end of the scenario transcript) include earlier passes and differ from a first run; the assertions are deltas and do not depend on them. Wall times are one machine and one load level.

## 2. Beat table: what is asserted

Error notation: `relay N`, `agent_auth N` (core), `token N` (SPL Token), `mock_amm N`. Codes overlap across programs, so the scripts read the failing program from the logs (the SDK's `parseProgramError` does this).

| Beat | Step | Expected (asserted) |
|---|---|---|
| Setup | S1, S2 | onboarding in 2 transactions (595 B and 1072 B of 1232), plain-English explanation printed |
| 1 | 1.1 hot-wallet agent obeys the injection | succeeds, MALLORY +50 DUSD (the control) |
| 2 | 2.1 pay 3 DUSD to ACME; 2.2 swap 5 DUSD on the mock pool | both succeed; swap output equals the constant-product quote |
| 3 | 3.1 pay MALLORY | relay 104 RecipientNotAllowed |
| 3 | 3.2 40 DUSD to ACME | agent_auth 8 PerTxExceeded |
| 3 | 3.3 90 DUSD to ACME | relay 105 TokenAccountState (the SPL delegation is the independent cap) |
| 3 | 3.4 five 5 DUSD transfers in one transaction | agent_auth 9 SpendLimitExceeded at instruction 3; the whole transaction reverts |
| 3 | 3.5 raw TransferChecked by the agent key | token 4 OwnerMismatch |
| 3 | 3.6 raw Approve(delegate = MALLORY) | token 4 OwnerMismatch |
| 3 | 3.7 raw SetAuthority(AccountOwner -> MALLORY) | token 4 OwnerMismatch |
| 3 | 3.8 relay tag 5 (Approve through the relay) | relay 100 InvalidInstructionData |
| 3 | 3.9 swap output to MALLORY | relay 102 AccountMismatch |
| 3 | 3.10 direct `verify(Token, Approve)` | agent_auth 7 DiscriminatorNotAllowed |
| 4 | 4.1 `gated_action(4)`; 4.2 `gated_action(11)` | success; agent_auth 8 PerTxExceeded |
| 5 | 5.1 owner `remove_permission(Token)`; 5.2 pay | success; agent_auth 6 ProgramNotAllowed |
| 5 | 5.3 swap | succeeds (the AMM slot is untouched) |
| 5 | 5.4 owner re-adds Token with discriminator `[3,0,0,0,0,0,0,0]` only; 5.5 pay | success; agent_auth 7 DiscriminatorNotAllowed |
| 5 | 5.6 owner restores TransferChecked; 5.7 swap | success; agent_auth 9 SpendLimitExceeded (AMM lifetime 10 of 10) |
| 6 | 6.1a/b `set_paused(1)` then pay; 6.2a/b `set_paused(0)` then pay | success; relay 116 Paused; success; success |
| 7 | 7.0 owner raises the AMM lifetime limit; 7.1 searcher moves the price; 7.2 agent swap; 7.3 searcher swaps back | success; success; mock_amm 7001 ExceededSlippage; success |
| 8 | 8.1 one-transaction unwind (377 B); 8.2 delegation none, balance intact; 8.3 agent pays | success; asserted; relay 101 InvalidPolicy |

After every state-changing beat the scenario asserts a running ledger (owner, payee, MALLORY, SPL delegation left, per-program spend). The scenario scoreboard ends at: hot-wallet agent attempted 1, blocked 0, allowed 1, funds lost to the attacker 50 DUSD; mandate agent attempted 22, blocked 17, allowed 5, funds lost to the attacker 0.

"Funds lost to the attacker 0" is a statement about MALLORY only. The agent can still move value to its allowlisted payee and into in-bounds swaps up to the budget; the `attacks` scoreboard counts that separately (section 3).

### Deviations from the design script (DEMO-SCRIPT.md), in the open

1. Token and amounts: the bootstrapped environment uses DUSD/DOUT with the owner at 1,000 DUSD and a 10,000/10,000 pool (the script used 100 tUSDC and a 1,000/1,000 pool). Ledger checks are deltas against live balances and quotes computed from the live vaults, so numbers differ but the relations hold.
2. Beat 7 needs a step the script does not have: beat 5 leaves the AMM slot at its lifetime limit (10 of 10), so a swap in beat 7 would stop at agent_auth 9 before reaching the AMM. The scenario inserts 7.0 (`update_permission` raising the AMM lifetime limit to 30; counters are kept) and says so on screen.
3. The SPL delegation (50) is deliberately larger than the mandate's lifetime limits (20 and 10); the SDK onboarding plan refuses that unless `allowOverride` is set, and the scripts set it knowingly. The explanation printed after onboarding warns about it.
4. Rent: the unwind returns 15,757,440 (mandate) and 7,461,120 (policy) lamports on this validator; the script's 11,501,120 and 5,445,760 are devnet figures. The scripts quote the validator they ran on.
5. 5.1 to 5.2 (error 6) and 5.4 to 5.5 (error 7) follow the core source: `remove_permission` removes the whole program slot; error 7 appears only after re-adding the program with a different discriminator list.
6. Beat 6 and some owner steps are split into two transactions (6.1a/6.1b); ids carry letters.

## 3. The attack suite (54 table rows, scripted)

`attacks` uses a fresh throwaway victim, a fresh agent and the real instructions; every attack is landed on chain (`skipPreflight`). After each one the suite compares balances (victim, payee, MALLORY x3, pool vaults), the SPL delegation and every mandate counter with the state before the attack and fails on any difference. The result table is at the end of [attacks.txt](transcripts/attacks.txt). Classes:

* **BLOCKED (51 rows)**: rejected with the documented error. The source is named: relay (account pins, wrong program, call depth), AgentAuth core (not owner, not allowed, spend limits, not active), the Token program (OwnerMismatch for every raw attempt by the agent key), the mock AMM (slippage) and the runtime (account count, replay). 22 distinct rejection outcomes.
* **NEUTRALISED (2 rows)**: pre-funding the mandate PDA and the policy PDA to block creation (RELAY-SPEC E06) does not stop the owner's `create_mandate` or `init_policy`.
* **ACCEPTED LIMIT (1 row)**: L4. `per_tx_limit` is per `verify` call, so two 5 DUSD payments to the allowlisted payee fit in one transaction when the lifetime limit is 10. The loss is bounded by the lifetime limit and goes only to the pinned payee.

### Table rows versus scoreboard counts

The table has 54 rows. The final scoreboard line of the run reads `attempted 53 | blocked 51 | allowed 2 | funds lost to the attacker 0 DUSD/DOUT | moved to the allowlisted payee within the budget 11 DUSD`. The relation, read from the transcript (`AT-` headings and scoreboard lines):

* 54 rows minus the 2 NEUTRALISED rows (AT-52, AT-53) = 52 rows. Those two are owner-signed creations racing a pre-funded PDA; nothing agent- or stranger-signed is attempted, so the scoreboard does not count them.
* The 52 remaining rows are 51 BLOCKED (scoreboard "blocked 51") plus the L4 row AT-50 (an "allowed").
* The 53rd scoreboard attempt, and the second "allowed", is the helper step `AT-replay-1`: the legitimate 1 DUSD payment whose signed transaction is then replayed as AT-45. It has no table row.
* "Moved to the allowlisted payee 11 DUSD" = 1 DUSD (`AT-replay-1`) + 10 DUSD (AT-50). Funds to MALLORY: 0.

Two caveats on the closing text the script prints: its sentence "a few scoreboard attempts have no row of their own" is looser than the accounting above (exactly one has none), and "22 distinct rejection outcomes" is the script's own count.

Observed behaviours worth knowing: a missing or extra account is refused with the runtime's `NotEnoughAccountKeys`, not a relay code; the agent calling `init_policy` for the victim fails with relay 109 NotPolicyOwner; the CPI-depth attack wraps the relay transfer in the mock AMM's `proxy` instruction and is stopped by the policy's STRICT_TOP_LEVEL flag (relay 115 NotTopLevel).

## 4. The 90-second narration

Run `scenario` without `--fast`, or cut a recording to these beats.

| Time | Beat | Say | Show |
|---|---|---|---|
| 0:00-0:10 | Problem | "Agents hold a key. A prompt injection makes that key do what an attacker says. We do not stop the injection; we cap what a fooled agent can do, on-chain. Local validator, mock funds, unaudited prototype." | the banner; the injected invoice |
| 0:10-0:22 | Control (1.1) | "The same injection against a normal agent whose wallet holds the funds: one transaction, everything gone. The attacker is a script, labelled." | `ALLOWED`, funds lost to the attacker 50 DUSD |
| 0:22-0:34 | Onboarding and normal work (S1, S2, 2.1, 2.2) | "The owner gives the agent a mandate in two transactions: programs and instructions, per-call and lifetime limits, one allowlisted payee, one pinned pool, a bounded allowance. The agent pays the invoice and swaps." | the plain-English explanation (can / cannot / enforcement) |
| 0:34-0:58 | Injection (3.1-3.10) | "Pay the attacker: relay 104. Pay above the per-call cap: AgentAuth 8. Split it over five instructions: AgentAuth 9, and the whole transaction reverts. Raw transfer, approve, set-authority with the agent key: the Token program says OwnerMismatch; any wallet does that." | the scoreboard line, funds lost to the attacker 0 |
| 0:58-1:10 | Second integrator (4.1, 4.2) | "A different program with nothing to do with the relay checks the same mandate with one CPI. That check is advisory unless the program derives the values it passes." | `gated_action(4)` ok, `gated_action(11)` AgentAuth 8 |
| 1:10-1:22 | Live per-instruction revoke (5.1-5.5) | "The owner edits the mandate while the agent runs. Remove the Token permission: error 6, the swap still works. Add Token back with a different instruction list: error 7." | 5.2 error 6, 5.3 swap ok, 5.5 error 7 |
| 1:22-1:30 | Unwind and honest limits (8.1, 8.3) | "One transaction revokes the delegation and closes the mandate and policy; the next payment fails. The agent could still pay its allowlisted payee up to the budget: that is the blast radius. Hard enforcement only for the relay transfer and the pinned swap." | `8.1 ALLOWED`, `8.3 relay 101`, final result table |

## 5. Honest limits

What the runs show: on a local validator, with the `test-amm` relay build and a mock AMM, a scripted agent key and a scripted stranger could not move value to MALLORY through 54 table rows, and every protected balance, delegation and counter was unchanged after each blocked attempt. What they do not show: absence of bugs (the programs are unaudited), behaviour on a real AMM, MEV protection (the swap price floor is a static guard), or anything about an LLM. `verify` checks caller-reported values, so outside the relay transfer and pinned swap a mandate is advisory. The agent can spend its budget quickly on its allowlisted payee (L4). In the demo the attacker is a script: beats are labelled `SCRIPTED`.

Do not say: audited, trustless, prevents prompt injection, MEV-safe, "the agent can no longer move the money", first or only, immutable, mainnet-ready.

## 6. Live LLM agent

`apps/demo/live-agent/` contains `live-setup`, `live-check` and `live-unwind`, the malicious invoice, the prompt, an MCP configuration and the recording checklist; see [apps/demo/live-agent/README.md](../apps/demo/live-agent/README.md). Status: **harness only**. No LLM was run for this guide, and the MCP server was not driven end to end by this work. A model may refuse the injection; the harness reports that honestly, and the scripted suite remains the evidence. If you show the live beat, show the normal payment and the first injection attempt only, and say that a model may refuse.
