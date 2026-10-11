# Equivalent core mutants (written proofs)

Three of the 206 core mutants are equivalent. They survive every test by construction, not because a
test is missing. The proofs are the author's reading of the source and of pinocchio 0.9.3; they were
not machine-checked. `V06` and `V08` rely on the `close()` semantics of pinocchio 0.9.3. The
mutants are runnable (`python3 security/mutation-core/run.py --ids S18,V06,V08`): a test that kills one
of them would falsify the proof.

## S18  `src/state.rs`  swap_remove: always copy_within (idx == last is a self-copy)

`copy_within(src..src+128, dst)` with `src == dst` (the only case the `if idx != last` guard excludes,
`idx == last`) is a memmove of a range onto itself, a no-op. The zeroing of the tail slot and the length
update that follow are identical. Same final bytes for every input.

## V06  `src/instructions/revoke_mandate.rs`  revoke: do not wipe data before close

`close()` zeroes data_len, lamports and owner (pinocchio 0.9.3 `close_unchecked`), and the runtime
zeroes/discards the data at the end of the instruction. After revoke the account has data_len 0, so no
byte of the old data is reachable by any later instruction or CPI. A re-create runs `Mandate::initialize`,
which zero-fills the whole buffer first. The explicit wipe is defence in depth with no observable
behaviour (and could be removed).

## V08  `src/instructions/revoke_mandate.rs`  revoke: do not zero the mandate lamports

`close()` memsets the lamports field to 0 immediately afterwards and nothing reads the lamports in
between (the `RefMut` is dropped at the end of the block), so the explicit `= 0` is overwritten before it
can be observed. Final account state is identical.

## Legacy set

`R7` of `mutants-legacy99.json` ("revoke: no data wipe") is the same edit in effect as V06 and is the one
survivor of that set (`98 killed, 1 equivalent`). That identifies the "one equivalent survivor" quoted in
docs/SECURITY.md section 8.1.
