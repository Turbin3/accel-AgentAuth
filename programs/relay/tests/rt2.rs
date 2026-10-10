//! Regression tests for the relay red-team finding RT-F7, written against the real `.so` files
//! in LiteSVM.
//!
//! | finding | what is pinned here |
//! |---|---|
//! | RT-F7 | A corrupted STORED `authority_bump` in the policy (offset 3; a field only the relay itself writes, from `find_program_address` at `init_policy`) makes the relay's signed CPI fail in the RUNTIME, not with a relay code: `ProgramFailedToComplete` ("Could not create program address with signer seeds") when `["authority", mandate, bump]` is on the curve, `PrivilegeEscalation` when it derives some other PDA. Both are atomic reverts after the core `verify` CPI succeeded: no balance, delegation, spend counter, call counter or account byte changes, on `transfer` and `swap`, on every token flavour. The relay does not re-derive the bump on the hot path (spec: stored bumps only), and the field is not attacker reachable, so the program is unchanged (documented, not fixed). |

#![allow(clippy::too_many_lines)]

#[macro_use]
mod common;
use common::*;

use solana_pubkey::Pubkey;
use solana_transaction::InstructionError;

/// Offset of the stored authority bump in the policy account (RELAY-SPEC section 4).
const OFF_AUTHORITY_BUMP: usize = 3;
const CREATE_PDA_MSG: &str = "Could not create program address with signer seeds";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
    /// `["authority", mandate, bump]` is on the curve: no address at all.
    NoAddress,
    /// It derives some PDA that is not the policy's authority.
    OtherPda,
}

fn classify(ctx: &Ctx, bump: u8) -> Class {
    match Pubkey::create_program_address(
        &[AUTHORITY_SEED, ctx.mandate.as_ref(), &[bump]],
        &RELAY_ID,
    ) {
        Err(_) => Class::NoAddress,
        Ok(k) => {
            assert_ne!(
                k, ctx.authority,
                "only the canonical bump derives the authority"
            );
            Class::OtherPda
        }
    }
}

/// First stored bump (other than the real one) of the requested class.
fn bump_of_class(ctx: &Ctx, want: Class) -> u8 {
    let good = ctx.policy_bytes()[OFF_AUTHORITY_BUMP];
    (0..=255u8)
        .filter(|b| *b != good)
        .find(|b| classify(ctx, *b) == want)
        .unwrap_or_else(|| panic!("no bump of class {want:?}"))
}

fn set_bump(ctx: &mut Ctx, bump: u8) {
    let policy = ctx.policy;
    ctx.edit_account(&policy, |a| a.data[OFF_AUTHORITY_BUMP] = bump);
}

/// Everything the attack could have moved, read through the harness.
fn state(ctx: &Ctx, swap: bool) -> (Snapshot, u64, u32, u64) {
    let (src, prog) = if swap {
        let s = ctx.swap_fixture();
        (s.in_account, s.amm_program)
    } else {
        (ctx.source, ctx.token_program)
    };
    let p = ctx.perm(&prog);
    (
        ctx.snapshot(),
        ctx.token(&src).delegated_amount,
        p.call_count,
        p.spend_total,
    )
}

fn run_variant(ctx: &mut Ctx, swap: bool, want: Class) {
    let good = ctx.policy_bytes()[OFF_AUTHORITY_BUMP];
    let bump = bump_of_class(ctx, want);
    set_bump(ctx, bump);
    let before = state(ctx, swap);
    let ix = if swap {
        ctx.swap_ix_default(1_000)
    } else {
        ctx.transfer_ix(1_000)
    };
    let e = ctx.send_agent(&[ix]);
    match want {
        Class::NoAddress => {
            e.assert_instruction_error(InstructionError::ProgramFailedToComplete);
            assert!(
                e.logs().iter().any(|l| l.contains(CREATE_PDA_MSG)),
                "{}",
                e.pretty_logs()
            );
        }
        Class::OtherPda => {
            e.assert_instruction_error(InstructionError::PrivilegeEscalation);
        }
    }
    // The core verify CPI ran and succeeded first (this is what makes it an atomic REVERT).
    assert!(
        e.logs()
            .iter()
            .any(|l| l.contains(&format!("Program {AGENT_AUTH_ID} success"))),
        "{}",
        e.pretty_logs()
    );
    let after = state(ctx, swap);
    assert_nothing_moved(&before.0, &after.0);
    assert_eq!(before.1, after.1, "delegated amount changed");
    assert_eq!(before.2, after.2, "call counter changed");
    assert_eq!(before.3, after.3, "spend counter changed");
    // restoring the bump restores service: the failure is the bump, nothing else.
    set_bump(ctx, good);
    let ix = if swap {
        ctx.swap_ix_default(1_000)
    } else {
        ctx.transfer_ix(1_000)
    };
    ctx.send_agent(&[ix]).assert_ok();
}

triple_token!(
    rt_f7_transfer_bump_not_on_curve_is_runtime_error_and_atomic,
    |ctx| {
        run_variant(ctx, false, Class::NoAddress);
    }
);
triple_token!(
    rt_f7_transfer_bump_other_pda_is_privilege_escalation_and_atomic,
    |ctx| {
        run_variant(ctx, false, Class::OtherPda);
    }
);
triple_token!(
    rt_f7_swap_bump_not_on_curve_is_runtime_error_and_atomic,
    with | b | b.with_swap(),
    |ctx| {
        run_variant(ctx, true, Class::NoAddress);
    }
);
triple_token!(
    rt_f7_swap_bump_other_pda_is_privilege_escalation_and_atomic,
    with | b | b.with_swap(),
    |ctx| {
        run_variant(ctx, true, Class::OtherPda);
    }
);

// All 255 wrong bumps, both instructions: exactly the two runtime failure shapes, never a
// success, never a state change, and the class matches `create_program_address`.
dual_token!(
    rt_f7_every_wrong_bump_fails_atomically,
    with | b | b.with_swap(),
    |ctx| {
        let good = ctx.policy_bytes()[OFF_AUTHORITY_BUMP];
        for swap in [false, true] {
            for b in (0..=255u8).filter(|b| *b != good) {
                set_bump(ctx, b);
                let before = state(ctx, swap);
                let ix = if swap {
                    ctx.swap_ix_default(1_000)
                } else {
                    ctx.transfer_ix(1_000)
                };
                let e = ctx.send_agent(&[ix]);
                let want = match classify(ctx, b) {
                    Class::NoAddress => InstructionError::ProgramFailedToComplete,
                    Class::OtherPda => InstructionError::PrivilegeEscalation,
                };
                e.assert_instruction_error(want);
                let after = state(ctx, swap);
                assert_nothing_moved(&before.0, &after.0);
                assert_eq!(
                    (before.1, before.2, before.3),
                    (after.1, after.2, after.3),
                    "bump {b}"
                );
            }
            set_bump(ctx, good);
        }
    }
);
