//! Permanent regression tests distilled from the 2026-10 review PoCs.
//!
//! Two kinds, labelled in each test's doc comment:
//!
//! * FIXED: the PoC demonstrated a bug; the test now asserts the fixed behaviour.
//! * LIMITATION: the PoC demonstrated a property that is kept by design (the
//!   locked ABI/layout, or the advisory nature of `verify`). The test pins the
//!   current semantics so a silent change shows up, and its name says what an
//!   integrator must not assume.
//!
//! Pre-funded PDA, revoke + refund in one transaction, create after revoke,
//! the unlimited-permission brick and the expiry boundary have their FIXED tests
//! in `regression_lifecycle.rs` / `regression_verify.rs`.

mod common;
use common::integration::*;

fn mixed(parts: &[&[u8]]) -> Pubkey {
    // a deterministic "scope" key derived from several byte strings
    let mut buf = [0u8; 32];
    for (i, part) in parts.iter().enumerate() {
        for (j, b) in part.iter().enumerate() {
            buf[(i * 7 + j) % 32] ^= b.wrapping_add(i as u8 + 1);
        }
    }
    Pubkey::new_from_array(buf)
}

// --- LIMITATION: unit of account ------------------------------------------------------

/// MATH-6. A permission has one counter, in whatever unit the caller reports.
/// 600 "units" of mint A and 400 of mint B draw down the same 1,000 budget, and
/// nothing on-chain says what a unit is. Hard per-asset budgets need a different
/// permission key per asset (below) or the relay, which pins the mint.
#[test]
fn limitation_one_counter_is_shared_by_every_asset_reported_under_a_program() {
    let Some((mut e, token_program)) = Env::with_permission(1_000, 0) else {
        return;
    };
    assert_ok(e.verify(&token_program, &DISC, 600)); // "600 of mint A"
    assert_ok(e.verify(&token_program, &DISC, 400)); // "400 of mint B"
    assert_code(e.verify(&token_program, &DISC, 1), E::SpendLimitExceeded);
    assert_eq!(spend_total(&e.data(), 0), 1_000);
}

/// MATH-6, the workable convention: the "program id" of a slot is just 32 bytes,
/// so an integrator may register (program, mint) scoped keys and get one
/// independent budget per asset with no on-chain change.
#[test]
fn scoped_keys_give_each_asset_its_own_budget() {
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE));
    let token_program = Pubkey::new_unique();
    let (mint_a, mint_b) = (Pubkey::new_unique(), Pubkey::new_unique());
    let scope_a = mixed(&[token_program.as_ref(), mint_a.as_ref()]);
    let scope_b = mixed(&[token_program.as_ref(), mint_b.as_ref()]);
    assert_ne!(scope_a, scope_b);
    assert_ok(e.add(&scope_a, 1_000, 0, &[DISC]));
    assert_ok(e.add(&scope_b, 50, 0, &[DISC]));

    assert_ok(e.verify(&scope_a, &DISC, 1_000));
    assert_code(e.verify(&scope_a, &DISC, 1), E::SpendLimitExceeded);
    assert_ok(e.verify(&scope_b, &DISC, 50));
    assert_code(e.verify(&scope_b, &DISC, 1), E::SpendLimitExceeded);
    // an unscoped call finds neither slot
    assert_code(e.verify(&token_program, &DISC, 1), E::ProgramNotAllowed);
}

// --- LIMITATION: caller-reported values -----------------------------------------------

/// MATH-7 / CPI-4. `verify` records what the caller says. An agent that
/// reports amount 0 is never limited and never spends budget; the program
/// cannot see the transfer. This is why `verify` alone is advisory and the
/// relay derives the amount from the action itself.
#[test]
fn limitation_an_agent_that_under_reports_the_amount_is_never_limited() {
    let Some((mut e, t)) = Env::with_permission(10, 5) else {
        return;
    };
    for _ in 0..50 {
        assert_ok(e.verify(&t, &DISC, 0));
    }
    let d = e.data();
    assert_eq!(spend_total(&d, 0), 0);
    assert_eq!(call_count(&d, 0), 50);
    // the limits still bite for honest reports
    assert_code(e.verify(&t, &DISC, 6), E::PerTxExceeded);
}

/// MATH-7. The program id and discriminator are reported too; `verify` cannot
/// tell whether the agent then calls that program.
#[test]
fn limitation_verify_is_satisfied_by_any_reported_pair_the_mandate_lists() {
    let Some((mut e, t)) = Env::with_permission(0, 0) else {
        return;
    };
    // nothing relates the report to a real call: the same report can be replayed
    for _ in 0..3 {
        assert_ok(e.verify(&t, &DISC, 1));
    }
    assert_eq!(call_count(&e.data(), 0), 3);
}

/// ACCT-5 / CPI-3. Anyone can create a mandate that names any agent, without the
/// agent's consent and without owning anything the integrator protects. A
/// mandate is only meaningful together with a check of `mandate.owner` by the
/// integrator. The core only blocks the degenerate owner == agent form.
#[test]
fn limitation_a_stranger_can_author_a_mandate_naming_a_victim_agent() {
    let Some(mut e) = env() else { return };
    let attacker = funded(&mut e.svm, 10_000_000_000);
    let victim_agent = e.agent.insecure_clone();
    let t = Pubkey::new_unique();

    // the attacker is the owner of this mandate and names the victim as its agent
    assert_ok(e.run_as(
        &attacker,
        &[create_ix(
            &attacker.pubkey(),
            &victim_agent.pubkey(),
            FUTURE,
        )],
    ));
    let mandate = pda(&attacker.pubkey(), &victim_agent.pubkey()).0;
    assert_ok(e.run_as(
        &attacker,
        &[add_ix(&attacker.pubkey(), &mandate, &t, 0, 0, &[DISC])],
    ));

    // verify passes with the attacker as owner: what it proves is "the owner
    // key in this mandate granted this", not "the funds' owner granted this"
    let ix = verify_ix(
        &mandate,
        &attacker.pubkey(),
        &victim_agent.pubkey(),
        &t,
        &DISC,
        1,
    );
    assert_ok(send(&mut e.svm, &[&attacker, &victim_agent], &[ix]));
    // and with a different owner account the same mandate is refused
    let ix = verify_ix(
        &mandate,
        &e.owner_key(),
        &victim_agent.pubkey(),
        &t,
        &DISC,
        1,
    );
    let owner = e.owner.insecure_clone();
    assert_code(
        send(&mut e.svm, &[&owner, &victim_agent], &[ix]),
        E::NotOwner,
    );
}

/// MATH-8, FIXED half: the self-issued form is refused.
#[test]
fn fixed_owner_cannot_be_its_own_agent() {
    let Some(mut e) = env() else { return };
    let ix = create_ix(&e.owner_key(), &e.owner_key(), FUTURE);
    assert_code(e.run(ix), E::InvalidAgent);
}

/// MATH-1 / LIFE: `0` means unlimited, never "nothing". Pinned because an SDK
/// that forwards a user's `0` meaning "no spending" would grant everything.
#[test]
fn limitation_zero_limits_mean_unlimited_not_zero_budget() {
    let Some((mut e, t)) = Env::with_permission(0, 0) else {
        return;
    };
    assert_ok(e.verify(&t, &DISC, 1_000_000_000_000_000_000));
    assert_ok(e.verify(&t, &DISC, 1_000_000_000_000_000_000));
    // the smallest enforceable "almost nothing" is a limit of 1
    assert_ok(e.update(&t, 1, 1));
    // spend_total is already far above the new lifetime limit, so it is blocked
    assert_code(e.verify(&t, &DISC, 0), E::SpendLimitExceeded);
}

// --- FIXED: expiry units --------------------------------------------------------------

/// MATH-5, FIXED: a duration (30 days in seconds) passed as an expiry used to
/// create a mandate that was born expired and said nothing; it is refused now.
#[test]
fn fixed_a_duration_passed_as_expiry_is_refused() {
    let Some(mut e) = env() else { return };
    set_time(&mut e.svm, 1_800_000_000);
    assert_code(e.create(30 * 24 * 3_600), E::InvalidExpiry);
    assert!(e.account().is_none());
}

/// MATH-5, LIMITATION: a millisecond timestamp is indistinguishable on-chain
/// from a far-future second count and is accepted. The SDK must validate units.
#[test]
fn limitation_a_millisecond_expiry_is_accepted_and_effectively_never_expires() {
    let Some(mut e) = env() else { return };
    set_time(&mut e.svm, 1_800_000_000);
    let millis = 1_800_000_000_000i64;
    assert_ok(e.create(millis));
    let t = Pubkey::new_unique();
    assert_ok(e.add(&t, 0, 0, &[DISC]));
    warp(&mut e.svm, 10 * 365 * 24 * 3_600);
    assert_ok(e.verify(&t, &DISC, 1));
}

/// Expiry is immutable by design: no instruction rewrites it, a lifetime change
/// is revoke + create.
#[test]
fn expiry_never_changes_through_any_instruction() {
    let Some(mut e) = env() else { return };
    assert_ok(e.create(NOW + 500));
    let t = Pubkey::new_unique();
    assert_ok(e.add(&t, 10, 10, &[DISC]));
    assert_ok(e.update(&t, 20, 20));
    assert_ok(e.verify(&t, &DISC, 1));
    assert_ok(e.set_active(0));
    assert_ok(e.set_active(1));
    assert_ok(e.remove(&t));
    assert_eq!(expiry_of(&e.data()), NOW + 500);
}

// --- FIXED / runtime properties: same-transaction composition --------------------------

/// A failing instruction rolls back earlier verifies of the same transaction:
/// the caller cannot keep a counter bump from a transaction that then aborts.
#[test]
fn a_failing_instruction_rolls_back_earlier_verifies_in_the_same_transaction() {
    let Some((mut e, t)) = Env::with_permission(1_000, 0) else {
        return;
    };
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let ixs = [
        verify_ix(&m, &o, &a, &t, &DISC, 100),
        verify_ix(&m, &o, &a, &t, &DISC, 100),
        verify_ix(&m, &o, &a, &t, &DISC, 5_000), // over the limit
    ];
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    assert_code(
        send(&mut e.svm, &[&owner, &agent], &ixs),
        E::SpendLimitExceeded,
    );
    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (0, 0));
}

#[test]
fn two_verifies_in_one_transaction_accumulate() {
    let Some((mut e, t)) = Env::with_permission(1_000, 0) else {
        return;
    };
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let ixs = [
        verify_ix(&m, &o, &a, &t, &DISC, 300),
        verify_ix(&m, &o, &a, &t, &DISC, 300),
        verify_ix(&m, &o, &a, &t, &DISC, 300),
    ];
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    assert_ok(send(&mut e.svm, &[&owner, &agent], &ixs));
    let d = e.data();
    assert_eq!((spend_total(&d, 0), call_count(&d, 0)), (900, 3));
    // and the budget is shared across the transaction boundary: 100 left
    assert_code(e.verify(&t, &DISC, 101), E::SpendLimitExceeded);
}

/// CPI-6 / ACCT-6. After a revoke the mandate cannot be used for the rest of the
/// same transaction (the account is gone, owned by the System Program).
#[test]
fn verify_after_revoke_in_the_same_transaction_fails_with_14() {
    let Some((mut e, t)) = Env::with_permission(0, 0) else {
        return;
    };
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let ixs = [revoke_ix(&o, &m), verify_ix(&m, &o, &a, &t, &DISC, 1)];
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    assert_code(
        send(&mut e.svm, &[&owner, &agent], &ixs),
        E::AccountOwnerMismatch,
    );
    assert!(e.account().is_some(), "the whole transaction rolled back");
    assert_eq!(call_count(&e.data(), 0), 0);
}

/// ... and the other order is fine: a verify that came first is recorded until
/// the revoke closes the account.
#[test]
fn verify_then_revoke_in_the_same_transaction_succeeds() {
    let Some((mut e, t)) = Env::with_permission(0, 0) else {
        return;
    };
    let (m, o, a) = (e.mandate(), e.owner_key(), e.agent_key());
    let ixs = [verify_ix(&m, &o, &a, &t, &DISC, 1), revoke_ix(&o, &m)];
    let (owner, agent) = (e.owner.insecure_clone(), e.agent.insecure_clone());
    assert_ok(send(&mut e.svm, &[&owner, &agent], &ixs));
    assert!(e.account().is_none());
}

#[test]
fn create_then_revoke_in_one_transaction_leaves_nothing_behind() {
    let Some(mut e) = env() else { return };
    let (o, a, m) = (e.owner_key(), e.agent_key(), e.mandate());
    let before = e.svm.get_balance(&o).unwrap();
    assert_ok(e.run_as(
        &e.owner.insecure_clone(),
        &[create_ix(&o, &a, FUTURE), revoke_ix(&o, &m)],
    ));
    assert!(e.account().is_none());
    assert_eq!(
        e.svm.get_balance(&o).unwrap(),
        before - 5_000,
        "only the fee is lost"
    );
}

#[test]
fn creating_twice_in_one_transaction_fails_the_second_with_3() {
    let Some(mut e) = env() else { return };
    let (o, a) = (e.owner_key(), e.agent_key());
    assert_code(
        e.run_as(
            &e.owner.insecure_clone(),
            &[create_ix(&o, &a, FUTURE), create_ix(&o, &a, FUTURE + 1)],
        ),
        E::AlreadyInitialized,
    );
    assert!(e.account().is_none(), "rolled back");
}

/// Runtime property (LIFE-2 follow-up): re-funding a closed mandate with less
/// than the 0-byte rent floor in the same transaction is refused by the runtime,
/// so no unusable dust account can be created that way.
#[test]
fn revoke_followed_by_a_dust_transfer_is_rejected_by_the_runtime() {
    let Some((mut e, _t)) = Env::with_permission(0, 0) else {
        return;
    };
    let (o, m) = (e.owner_key(), e.mandate());
    let result = e.run_as(
        &e.owner.insecure_clone(),
        &[revoke_ix(&o, &m), system_transfer(&o, &m, 1)],
    );
    assert!(
        result.is_err(),
        "1 lamport cannot keep a 0-byte account alive"
    );
    assert!(e.account().is_some(), "rolled back: the mandate is intact");
}

/// Donations to a live mandate are not stranded: revoke pays the owner every
/// lamport the account holds, not just the rent.
#[test]
fn donations_to_a_live_mandate_go_to_the_owner_on_revoke() {
    let Some((mut e, _t)) = Env::with_permission(0, 0) else {
        return;
    };
    let donor = funded(&mut e.svm, 5_000_000_000);
    let m = e.mandate();
    assert_ok(e.run_as(&donor, &[system_transfer(&donor.pubkey(), &m, 1_234_567)]));
    let rent = e.svm.minimum_balance_for_rent_exemption(ACCOUNT_SIZE);
    assert_eq!(e.account().unwrap().lamports, rent + 1_234_567);

    let before = e.svm.get_balance(&e.owner_key()).unwrap();
    assert_ok(e.revoke());
    assert_eq!(
        e.svm.get_balance(&e.owner_key()).unwrap(),
        before + rent + 1_234_567 - 5_000
    );
}

/// Third parties can name the mandate as a writable account in their own
/// transactions (the runtime allows crediting any account), but they cannot
/// change its data or its owner.
#[test]
fn a_third_party_cannot_alter_a_mandate_by_naming_it() {
    let Some((mut e, t)) = Env::with_permission(100, 0) else {
        return;
    };
    let stranger = funded(&mut e.svm, 1_000_000_000);
    let before = Snapshot::take(&e.svm, &[e.mandate()]);
    let m = e.mandate();

    // System Assign on the program-owned mandate: only its owner program may do so
    let mut assign = vec![1, 0, 0, 0];
    assign.extend_from_slice(stranger.pubkey().as_ref());
    let ix = Instruction::new_with_bytes(
        solana_sdk_ids::system_program::ID,
        &assign,
        vec![AccountMeta::new(m, false)],
    );
    assert!(send(&mut e.svm, &[&stranger], &[ix]).is_err());
    before.assert_same(&Snapshot::take(&e.svm, &[m]), "assign attempt");

    // a verify with the stranger in the agent slot is refused and records nothing
    let ix = verify_ix(&m, &e.owner_key(), &stranger.pubkey(), &t, &DISC, 1);
    let owner = e.owner.insecure_clone();
    assert_code(
        send(&mut e.svm, &[&owner, &stranger], &[ix]),
        E::UnknownAgent,
    );
    before.assert_same(&Snapshot::take(&e.svm, &[m]), "stranger verify");
}
