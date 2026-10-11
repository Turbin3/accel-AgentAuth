# Equivalent relay mutants (written proofs)

A mutant is called equivalent here only with a written argument that no input, account state or
transaction can tell the mutated program from the original. Six of the 257 relay mutants are
equivalent. The proofs are the author's own reading of the source; they were not machine-checked.
Where a proof relies on pinocchio 0.9.3 behaviour (L05) it says so. If you doubt a proof, the mutant
is a runnable catalogue entry (`python3 security/mutation-relay/run.py --ids <ID>`): a test that
distinguishes it would be a finding.

## C02  `state.rs`  Policy::new: drop 944-byte length check

Proof: Policy::new is `if data.len() != POLICY_LEN {None}; Config::new(data.get(CONFIG_OFF..)?)`. Config::new returns None unless its slice is exactly CONFIG_LEN (800) bytes, and `get(144..)` is None when len < 144. So the surviving lines already imply len == 144 + 800 == 944 and the result is the same Option for every input. Dead check.

## L05  `ix/close_policy.rs`  close_policy: policy data not zero-filled before close

Proof: pinocchio-0.9.3 AccountInfo::close() zeroes lamports, owner and data_len and its documentation states that the account data is zeroed by the runtime at the end of the instruction in which the account was closed, so the explicit fill(0) is redundant: bytes beyond data_len are never persisted or visible to a later instruction. Witness W09 (close_policy + init_policy in one transaction, asserting the new policy bytes) passes on both binaries.

## N22  `ix/init_policy.rs`  init_policy: top-up also at existing == rent (zero-lamport transfer)

Proof: at existing == rent the mutant executes System Transfer of rent.saturating_sub(existing) = 0 lamports from the signing owner, which changes no balance and no data; Allocate/Assign follow identically. End state and error behaviour are identical (only +CU). Witness W17 (exact-rent prefund with a read-only owner meta) passes on both binaries, so even the one conceivable difference (privilege check on a writable `from`) is not observable.

## V16  `state.rs`  validate_swap: drop in_account != out_account

Proof: validate_swap's `in_account == out_account` rejection is always followed by validate_distinct (same call, `self.validate_distinct(id)` at the end of validate). If in_account == out_account: when in_account != source both are pushed into the key set (out_account unconditionally, in_account because it differs from source), so all_distinct() is false -> InvalidConfig; when in_account == source then out_account == source and out_account and source are both pushed -> duplicate -> InvalidConfig. Same error (113) from the same function, so no observable difference.

## V17  `state.rs`  validate_swap: drop out_account != source_account

Proof: `out_account == source_account` is also covered by validate_distinct: source_account is pushed unconditionally and, with swap enabled, out_account is pushed unconditionally; equal keys make all_distinct() false -> InvalidConfig (113), the same error the dropped check returns.

## X03  `lib.rs`  dispatch: empty data treated as tag 0 (init_policy)

Proof: empty data makes the original return Custom(100) at the dispatcher. The mutant treats it as tag 0 -> init_policy, whose FIRST statement is `if data.len() != INIT_DATA_LEN {return Err(InvalidInstructionData)}`; empty data has length 0 != 802, so it returns Custom(100) before any account is touched. Identical result for every input.

Witness note: for N22 and L05 the author also wrote witness tests (W17, W09 in
`programs/relay/tests/witness.rs`) that pass on both the original and the mutant, which is consistent
with the proofs (a passing witness is not a proof).
