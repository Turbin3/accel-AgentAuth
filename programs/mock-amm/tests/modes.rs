//! Executable specification of the mock AMM: the Raydium CP-Swap ABI, the constant-product math,
//! and what each of the 13 pool modes does, run against the real Token, p-token and Token-2022
//! binaries that ship inside LiteSVM.
//!
//! Run (from the repo root):
//! ```text
//! export PATH="$HOME/.cargo/bin:$PATH"
//! cargo build-sbf --manifest-path programs/mock-amm/Cargo.toml
//! cargo build-sbf --manifest-path Cargo.toml          # core, for the CpiVerify tests
//! MOCK_AMM_SO=$CARGO_TARGET_DIR/deploy/mock_amm.so AGENT_AUTH_SO=$CARGO_TARGET_DIR/deploy/agent_auth.so \
//!   cargo test -p mock-amm
//! ```
mod common;

use agent_auth::state::Mandate;
use common::*;
use mock_amm::{amount_out, Mode, PoolState, SWAP_DISC};

const AMOUNT_IN: u64 = 1_000_000;
/// floor(1e6 * 1e9 / (1e9 + 1e6)) for the default 1e9/1e9 pool.
const NORMAL_OUT: u64 = 999_000;

fn cfg(mode: Mode) -> Cfg {
    Cfg {
        mode: mode as u8,
        ..Cfg::default()
    }
}

fn owner_cfg(mode: Mode) -> Cfg {
    Cfg {
        payer_is_owner: true,
        ..cfg(mode)
    }
}

fn mock() -> Pubkey {
    mock_id()
}

// =============================================================================================
// ABI + NORMAL
// =============================================================================================

#[test]
fn normal_swap_moves_exact_constant_product_amounts() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Normal));
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        let meta = w
            .send(&[ix])
            .unwrap_or_else(|f| panic!("{fl:?}: {:?} {:#?}", f.err, f.meta.logs));
        println!(
            "CU mock-amm NORMAL swap ({fl:?}, standalone): {}",
            meta.compute_units_consumed
        );
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
        assert_eq!(amount(&w.svm, &w.in_vault), 1_000_000_000 + AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_vault), 1_000_000_000 - NORMAL_OUT);
        // the delegation shrank by exactly the pulled amount and is still the payer's
        assert_eq!(
            delegate_of(&w.svm, &w.in_account),
            (Some(w.payer.pubkey()), 5_000_000 - AMOUNT_IN)
        );
        // supplies untouched, pool state untouched
        assert_eq!(supply(&w.svm, &w.in_mint), SUPPLY);
        assert_eq!(supply(&w.svm, &w.out_mint), SUPPLY);
        let pool = w.svm.get_account(&w.pool.pubkey()).unwrap();
        assert_eq!(pool.data[0], 0);
    });
}

#[test]
fn normal_swap_reverse_direction_with_asymmetric_reserves() {
    each_flavour(|fl| {
        let c = Cfg {
            reverse: true,
            reserve_in: 2_000_000_000,
            reserve_out: 500_000_000,
            ..cfg(Mode::Normal)
        };
        let mut w = World::new(fl, c);
        // floor(1e6 * 5e8 / (2e9 + 1e6)) = 249_875
        let expect = amount_out(2_000_000_000, 500_000_000, AMOUNT_IN).unwrap();
        assert_eq!(expect, 249_875);
        let ix = w.swap_ix(AMOUNT_IN, expect);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.out_account), 249_875);
        assert_eq!(amount(&w.svm, &w.in_vault), 2_000_000_000 + AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_vault), 500_000_000 - 249_875);
    });
}

#[test]
fn slippage_boundary_is_exact_and_nothing_moves_on_failure() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Normal));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT + 1);
        assert_custom(w.send(&[ix]), &mock(), 7001);
        assert_eq!(w.snapshot(), before);
        // exactly the output passes
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
    });
}

#[test]
fn min_out_zero_is_accepted_by_the_amm_itself() {
    // The AMM does not impose a floor; the relay's `eff_min` is what protects the owner.
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let ix = w.swap_ix(AMOUNT_IN, 0);
    w.send(&[ix]).unwrap();
    assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
}

#[test]
fn zero_amount_and_zero_output_are_rejected() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Normal));
        let before = w.snapshot();
        let ix = w.swap_ix(0, 0);
        assert_custom(w.send(&[ix]), &mock(), 7004);
        // 1 raw unit into a 1e9/1e9 pool pays floor(1e9/(1e9+1)) = 0
        let ix = w.swap_ix(1, 0);
        assert_custom(w.send(&[ix]), &mock(), 7004);
        assert_eq!(w.snapshot(), before);
    });
}

#[test]
fn malformed_instruction_data_is_7005() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let good = World::swap_data(AMOUNT_IN, 0);
    for data in [
        vec![],
        vec![0x8f, 0xbe, 0x5a],
        good[..23].to_vec(),
        [good.clone(), vec![0]].concat(),
        {
            let mut d = good.clone();
            d[0] ^= 1; // unknown discriminator
            d
        },
    ] {
        let ix = Instruction::new_with_bytes(mock(), &data, w.swap_metas());
        assert_custom(w.send(&[ix]), &mock(), 7005);
    }
}

#[test]
fn fewer_than_thirteen_accounts_is_rejected() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let mut ix = w.swap_ix(AMOUNT_IN, 0);
    ix.accounts.pop();
    assert_err_contains(w.send(&[ix]), "NotEnoughAccountKeys");
}

#[test]
fn extra_trailing_accounts_are_ignored_by_a_normal_swap() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let ix = w.swap_ix_with(
        AMOUNT_IN,
        0,
        false,
        vec![AccountMeta::new_readonly(Pubkey::new_unique(), false)],
    );
    w.send(&[ix]).unwrap();
    assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
}

#[test]
fn pool_and_vault_validation() {
    each_flavour(|fl| {
        // (label, mutate world+ix, expected mock error code)
        type Case = (&'static str, fn(&mut World, &mut Instruction), u32);
        let cases: [Case; 10] = [
            (
                "pool not owned by the mock",
                |w, _| {
                    let mut a = w.svm.get_account(&w.pool.pubkey()).unwrap();
                    a.owner = solana_sdk_ids::system_program::ID;
                    w.svm.set_account(w.pool.pubkey(), a).unwrap();
                },
                7002,
            ),
            (
                "pool wrong length",
                |w, _| {
                    let mut a = w.svm.get_account(&w.pool.pubkey()).unwrap();
                    a.data.pop();
                    w.svm.set_account(w.pool.pubkey(), a).unwrap();
                },
                7002,
            ),
            (
                "undefined mode byte",
                |w, _| {
                    let mut a = w.svm.get_account(&w.pool.pubkey()).unwrap();
                    a.data[0] = 13;
                    w.svm.set_account(w.pool.pubkey(), a).unwrap();
                },
                7002,
            ),
            (
                "dirty reserved bytes",
                |w, _| {
                    let mut a = w.svm.get_account(&w.pool.pubkey()).unwrap();
                    a.data[3] = 1;
                    w.svm.set_account(w.pool.pubkey(), a).unwrap();
                },
                7002,
            ),
            (
                "wrong pool authority",
                |_, ix| {
                    ix.accounts[1] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                },
                7002,
            ),
            (
                "input token program is not a token program",
                |_, ix| {
                    ix.accounts[8] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                },
                7002,
            ),
            (
                "input mint owned by another program",
                |w, _| {
                    let mut a = w.svm.get_account(&w.in_mint).unwrap();
                    a.owner = solana_sdk_ids::system_program::ID;
                    w.svm.set_account(w.in_mint, a).unwrap();
                },
                7002,
            ),
            (
                "input vault is not one of the pool's vaults",
                |w, ix| {
                    let other = Pubkey::new_unique();
                    let a = w.svm.get_account(&w.in_vault).unwrap();
                    w.svm.set_account(other, a).unwrap();
                    ix.accounts[6] = AccountMeta::new(other, false);
                },
                7003,
            ),
            (
                "input vault holds the wrong mint",
                |w, _| {
                    let mut a = w.svm.get_account(&w.in_vault).unwrap();
                    a.data[0..32].copy_from_slice(w.out_mint.as_ref());
                    w.svm.set_account(w.in_vault, a).unwrap();
                },
                7003,
            ),
            (
                "input vault not owned by the pool authority",
                |w, _| {
                    let mut a = w.svm.get_account(&w.in_vault).unwrap();
                    a.data[32..64].copy_from_slice(Pubkey::new_unique().as_ref());
                    w.svm.set_account(w.in_vault, a).unwrap();
                },
                7003,
            ),
        ];
        for (label, mutate, code) in cases {
            let mut w = World::new(fl, cfg(Mode::Normal));
            let mut ix = w.swap_ix(AMOUNT_IN, 0);
            mutate(&mut w, &mut ix);
            let before = w.snapshot();
            let res = w.send(&[ix]);
            let f = res
                .as_ref()
                .err()
                .unwrap_or_else(|| panic!("{label}: should fail"));
            let (id, msg) = first_failure(&f.meta.logs).unwrap();
            assert_eq!(
                (id.as_str(), msg.as_str()),
                (
                    mock().to_string().as_str(),
                    format!("custom program error: {code:#x}").as_str()
                ),
                "{fl:?} / {label}"
            );
            assert_eq!(w.snapshot(), before, "{label}: state changed");
        }
    });
}

#[test]
fn same_vault_for_both_sides_is_rejected() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let mut ix = w.swap_ix(AMOUNT_IN, 0);
    ix.accounts[7] = AccountMeta::new(w.in_vault, false);
    assert_custom(w.send(&[ix]), &mock(), 7003);

    // even a (hand-made, degenerate) pool whose two vaults are the same key cannot be swapped,
    // including when both sides share one mint
    let mut w = World::new(
        Flavour::Classic,
        Cfg {
            same_mint: true,
            ..cfg(Mode::Normal)
        },
    );
    let mut pool = w.svm.get_account(&w.pool.pubkey()).unwrap();
    pool.data[40..72].copy_from_slice(w.in_vault.as_ref());
    w.svm.set_account(w.pool.pubkey(), pool).unwrap();
    let mut ix = w.swap_ix(AMOUNT_IN, 0);
    ix.accounts[7] = AccountMeta::new(w.in_vault, false);
    assert_custom(w.send(&[ix]), &mock(), 7003);
}

#[test]
fn payer_that_is_neither_owner_nor_delegate_is_rejected_by_the_token_program() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Normal));
        // hand the delegation to someone else: `payer` now has no authority over in_account
        let mut a = w.svm.get_account(&w.in_account).unwrap();
        a.data[76..108].copy_from_slice(Pubkey::new_unique().as_ref());
        w.svm.set_account(w.in_account, a).unwrap();
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, 0);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 4); // OwnerMismatch
        assert_eq!(w.snapshot(), before);
    });
}

#[test]
fn unsigned_payer_cannot_pull_funds() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let before = w.snapshot();
    let mut ix = w.swap_ix(AMOUNT_IN, 0);
    ix.accounts[0] = AccountMeta::new_readonly(w.payer.pubkey(), false);
    assert!(w.send(&[ix]).is_err());
    assert_eq!(w.snapshot(), before);
}

#[test]
fn delegation_cap_is_enforced_by_the_token_program() {
    each_flavour(|fl| {
        let c = Cfg {
            delegated: AMOUNT_IN - 1,
            ..cfg(Mode::Normal)
        };
        let mut w = World::new(fl, c);
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, 0);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 1); // InsufficientFunds
        assert_eq!(w.snapshot(), before);
    });
}

// =============================================================================================
// Modes
// =============================================================================================

/// Mode 1: normal price, but `amount_in + 1` leaves `in_account`.
#[test]
fn mode_1_pull_extra_pulls_one_more_than_requested() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::PullExtra));
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - AMOUNT_IN - 1);
        assert_eq!(amount(&w.svm, &w.in_vault), 1_000_000_000 + AMOUNT_IN + 1);
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT); // priced on amount_in
        assert_eq!(
            delegate_of(&w.svm, &w.in_account).1,
            5_000_000 - AMOUNT_IN - 1
        );
    });
}

/// Mode 1 against a delegation of exactly `amount_in`: the Token program stops the over-pull.
#[test]
fn mode_1_pull_extra_is_stopped_by_an_exact_delegation() {
    each_flavour(|fl| {
        let c = Cfg {
            delegated: AMOUNT_IN,
            ..cfg(Mode::PullExtra)
        };
        let mut w = World::new(fl, c);
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, 0);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 1); // InsufficientFunds
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 2: normal swap, then 1 unit burned from `in_account` with the payer's authority.
#[test]
fn mode_2_burn_in_burns_one_unit_when_the_mint_is_writable() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::BurnIn));
        let ix = w.swap_ix_with(AMOUNT_IN, NORMAL_OUT, true, vec![]);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - AMOUNT_IN - 1);
        assert_eq!(amount(&w.svm, &w.in_vault), 1_000_000_000 + AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
        assert_eq!(supply(&w.svm, &w.in_mint), SUPPLY - 1);
        assert_eq!(
            delegate_of(&w.svm, &w.in_account).1,
            5_000_000 - AMOUNT_IN - 1
        );
    });
}

/// Mode 2 as the relay calls it (`in_mint` read-only): the runtime refuses the Burn CPI.
#[test]
fn mode_2_burn_in_cannot_burn_when_the_mint_is_read_only() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::BurnIn));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT); // in_mint read-only, as in the relay's metas
        assert_err_contains(w.send(&[ix]), "PrivilegeEscalation");
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 3 with the real owner as payer: the delegate on `in_account` becomes the attacker.
#[test]
fn mode_3_approve_attacker_sets_the_attacker_as_delegate_when_payer_is_owner() {
    each_flavour(|fl| {
        let c = owner_cfg(Mode::ApproveAttacker);
        let attacker = c.aux;
        let mut w = World::new(fl, c);
        let ix = w.swap_ix_with(
            AMOUNT_IN,
            NORMAL_OUT,
            false,
            vec![AccountMeta::new_readonly(attacker, false)],
        );
        w.send(&[ix]).unwrap();
        assert_eq!(
            delegate_of(&w.svm, &w.in_account),
            (Some(attacker), u64::MAX)
        );
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT); // the swap itself was normal
    });
}

/// Mode 3 with a mere delegate as payer (the relay's PDA): Token returns OwnerMismatch (4).
#[test]
fn mode_3_approve_attacker_fails_with_owner_mismatch_for_a_delegate() {
    each_flavour(|fl| {
        for attacker_supplied in [true, false] {
            let c = cfg(Mode::ApproveAttacker);
            let attacker = c.aux;
            let mut w = World::new(fl, c);
            let before = w.snapshot();
            let extra = if attacker_supplied {
                vec![AccountMeta::new_readonly(attacker, false)]
            } else {
                vec![]
            };
            let ix = w.swap_ix_with(AMOUNT_IN, NORMAL_OUT, false, extra);
            assert_custom(w.send(&[ix]), &w.tp.clone(), 4);
            assert_eq!(w.snapshot(), before);
            assert_eq!(delegate_of(&w.svm, &w.in_account).0, Some(w.payer.pubkey()));
        }
    });
}

/// Mode 4 with the real owner as payer: ownership of `in_account` moves to `aux_key`.
#[test]
fn mode_4_set_auth_hands_the_account_to_the_attacker_when_payer_is_owner() {
    each_flavour(|fl| {
        let c = owner_cfg(Mode::SetAuth);
        let attacker = c.aux;
        let mut w = World::new(fl, c);
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(owner_field(&w.svm, &w.in_account), attacker);
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
    });
}

#[test]
fn mode_4_set_auth_fails_with_owner_mismatch_for_a_delegate() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::SetAuth));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 4);
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 5 with the real owner and an emptied `in_account`: the account is closed and its
/// lamports go to the destination.
#[test]
fn mode_5_close_account_closes_in_account_when_payer_is_owner_and_it_is_empty() {
    each_flavour(|fl| {
        let c = Cfg {
            in_balance: AMOUNT_IN, // the swap drains it exactly
            ..owner_cfg(Mode::CloseAccount)
        };
        let dest = c.aux;
        let mut w = World::new(fl, c);
        let rent = w.svm.get_account(&w.in_account).unwrap().lamports;
        let ix = w.swap_ix_with(
            AMOUNT_IN,
            NORMAL_OUT,
            false,
            vec![AccountMeta::new(dest, false)],
        );
        w.send(&[ix]).unwrap();
        assert!(w
            .svm
            .get_account(&w.in_account)
            .map(|a| a.lamports == 0)
            .unwrap_or(true));
        assert_eq!(w.svm.get_account(&dest).unwrap().lamports, rent);
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
    });
}

/// Mode 5 with a balance left over: Token refuses to close a non-empty account (NonNativeHasBalance = 11).
#[test]
fn mode_5_close_account_fails_on_a_non_empty_account() {
    each_flavour(|fl| {
        let mut w = World::new(fl, owner_cfg(Mode::CloseAccount));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 11);
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 5 as the relay's PDA delegate with an emptied account: OwnerMismatch (4).
#[test]
fn mode_5_close_account_fails_with_owner_mismatch_for_a_delegate() {
    each_flavour(|fl| {
        let c = Cfg {
            in_balance: AMOUNT_IN,
            ..cfg(Mode::CloseAccount)
        };
        let mut w = World::new(fl, c);
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 4);
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 6 on a degenerate same-mint pool: the output lands in `in_account`, not `out_account`.
#[test]
fn mode_6_redirect_output_pays_in_account_instead_of_out_account() {
    each_flavour(|fl| {
        let c = Cfg {
            same_mint: true,
            ..cfg(Mode::RedirectOutput)
        };
        let mut w = World::new(fl, c);
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(
            amount(&w.svm, &w.in_account),
            10_000_000 - AMOUNT_IN + NORMAL_OUT
        );
        assert_eq!(amount(&w.svm, &w.out_account), 0);
        assert_eq!(amount(&w.svm, &w.in_vault), 1_000_000_000 + AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_vault), 1_000_000_000 - NORMAL_OUT);
    });
}

/// Mode 6 with two distinct mints (every relay policy): the Token program rejects the
/// mint mismatch (MintMismatch = 3), so the redirect cannot complete.
#[test]
fn mode_6_redirect_output_hits_mint_mismatch_when_the_mints_differ() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::RedirectOutput));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        assert_custom(w.send(&[ix]), &w.tp.clone(), 3);
        assert_eq!(w.snapshot(), before);
    });
}

/// Mode 7: after the normal swap the mock CPIs the relay program id.
///
/// To prove the runtime (not a missing relay) is what stops it, a second copy of the mock is
/// installed AT the relay id and used as the top-level program: relay-id -> mock -> relay-id is
/// A -> B -> A. The callee program account must be among the accounts the mock received
/// (LiteSVM's mainnet feature set does not include `lift_cpi_caller_restriction`), so the
/// relay program is appended as a trailing account.
#[test]
fn mode_7_reenter_relay_is_rejected_by_the_runtime() {
    each_flavour(|fl| {
        let Some(so) = so_path("MOCK_AMM_SO") else {
            return;
        };
        let outer_for = |w: &World, with_relay_account: bool| {
            let extra = if with_relay_account {
                vec![AccountMeta::new_readonly(pk(RELAY), false)]
            } else {
                vec![]
            };
            let inner = w.swap_ix_with(AMOUNT_IN, NORMAL_OUT, false, extra);
            // top level: "relay" (mock copy) --proxy--> mock --swap--> "relay" again
            let mut outer = w.proxied(&inner);
            outer.program_id = pk(RELAY);
            outer.accounts[0] = AccountMeta::new_readonly(mock(), false);
            outer
        };

        let mut w = World::new(fl, cfg(Mode::ReenterRelay));
        w.svm.add_program_from_file(pk(RELAY), &so).unwrap();
        let before = w.snapshot();
        let outer = outer_for(&w, true);
        assert_err_contains(w.send(&[outer]), "ReentrancyNotAllowed");
        assert_eq!(w.snapshot(), before);

        // without the relay account among the mock's accounts the CPI cannot even be built
        let outer = outer_for(&w, false);
        assert_err_contains(w.send(&[outer]), "MissingAccount");
        assert_eq!(w.snapshot(), before);

        // control: identical plumbing with a NORMAL pool succeeds
        let mut ok = World::new(fl, cfg(Mode::Normal));
        ok.svm.add_program_from_file(pk(RELAY), &so).unwrap();
        let outer = outer_for(&ok, true);
        ok.send(&[outer]).unwrap();
        assert_eq!(amount(&ok.svm, &ok.out_account), NORMAL_OUT);
    });
}

/// Mode 7 with no relay in the transaction at all: the CPI cannot even be built.
#[test]
fn mode_7_reenter_relay_without_a_relay_program_fails_and_reverts() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::ReenterRelay));
    let before = w.snapshot();
    let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
    assert_err_contains(w.send(&[ix]), "MissingAccount");
    assert_eq!(w.snapshot(), before);
}

fn aa_so() -> Option<String> {
    so_path("AGENT_AUTH_SO")
}

/// A world whose pool `aux_key` is a mandate (owned by AgentAuth) naming the swap `payer` as the
/// agent and granting `perm_program` the `SWAP_DISC` discriminator.
fn mandate_world(fl: Flavour, perm_program: Pubkey) -> Option<(World, Pubkey, Pubkey)> {
    let aa = aa_so()?;
    let mut w = World::new(fl, cfg(Mode::CpiVerify));
    let aa_id = pk(AGENT_AUTH);
    let mandate_owner = Pubkey::new_unique();
    let agent = w.payer.pubkey();
    let (mandate, _) = Pubkey::find_program_address(
        &[
            agent_auth::MANDATE_SEED,
            mandate_owner.as_ref(),
            agent.as_ref(),
        ],
        &aa_id,
    );
    // point the pool's aux_key at the mandate
    let mut pool = w.svm.get_account(&w.pool.pubkey()).unwrap();
    pool.data[72..104].copy_from_slice(mandate.as_ref());
    w.svm.set_account(w.pool.pubkey(), pool).unwrap();

    let mut buf = vec![0u8; agent_auth::ACCOUNT_SIZE];
    {
        let mut m = Mandate::from_bytes(&mut buf).unwrap();
        m.set_discriminator(agent_auth::MANDATE_DISCRIMINATOR);
        m.set_owner(&mandate_owner.to_bytes());
        m.set_agent(&agent.to_bytes());
        m.set_expiry(i64::MAX);
        m.set_active(true);
        m.append_permission(
            &perm_program.to_bytes(),
            10_000_000,
            5_000_000,
            &[SWAP_DISC],
        )
        .unwrap();
    }
    w.svm.add_program_from_file(aa_id, aa).unwrap();
    w.svm
        .set_account(
            mandate,
            solana_account::Account {
                lamports: w
                    .svm
                    .minimum_balance_for_rent_exemption(agent_auth::ACCOUNT_SIZE),
                data: buf,
                owner: aa_id,
                ..Default::default()
            },
        )
        .unwrap();
    Some((w, mandate, mandate_owner))
}

fn counters(w: &World, mandate: &Pubkey) -> (u64, u32) {
    let mut data = w.svm.get_account(mandate).unwrap().data;
    let m = Mandate::from_bytes(&mut data).unwrap();
    let p = m.permission(0);
    (p.spend_total(), p.call_count())
}

/// Mode 8, attacker holds everything verify needs (agent signature included): verify runs
/// against the mandate in `aux_key` and the counters move by `amount_in`.
#[test]
fn mode_8_cpi_verify_books_spend_when_the_agent_signature_is_available() {
    each_flavour(|fl| {
        let Some((mut w, mandate, mowner)) = mandate_world(fl, mock()) else {
            return;
        };
        let ix = w.swap_ix_with(
            AMOUNT_IN,
            NORMAL_OUT,
            false,
            vec![
                AccountMeta::new(mandate, false),
                AccountMeta::new_readonly(mowner, false),
                AccountMeta::new_readonly(pk(AGENT_AUTH), false),
            ],
        );
        w.send(&[ix])
            .unwrap_or_else(|f| panic!("{:?} {:#?}", f.err, f.meta.logs));
        assert_eq!(counters(&w, &mandate), (AMOUNT_IN, 1));
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
    });
}

/// Mode 8 where the mandate does not cover the mock: AgentAuth itself rejects (ProgramNotAllowed = 6),
/// proving the verify CPI really happened.
#[test]
fn mode_8_cpi_verify_is_rejected_by_agent_auth_without_a_matching_permission() {
    let Some((mut w, mandate, mowner)) = mandate_world(Flavour::Classic, Pubkey::new_unique())
    else {
        return;
    };
    let before = w.snapshot();
    let ix = w.swap_ix_with(
        AMOUNT_IN,
        NORMAL_OUT,
        false,
        vec![
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(mowner, false),
            AccountMeta::new_readonly(pk(AGENT_AUTH), false),
        ],
    );
    assert_custom(w.send(&[ix]), &pk(AGENT_AUTH), 6);
    assert_eq!(w.snapshot(), before);
    assert_eq!(counters(&w, &mandate), (0, 0));
}

/// Mode 8 exactly as the relay would call it: the mandate/owner are not among the accounts,
/// so the attacker cannot even form the CPI.
#[test]
fn mode_8_cpi_verify_fails_when_mandate_accounts_are_not_supplied() {
    let Some((mut w, mandate, _)) = mandate_world(Flavour::Classic, mock()) else {
        return;
    };
    let before = w.snapshot();
    let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
    assert_err_contains(w.send(&[ix]), "NotEnoughAccountKeys");
    assert_eq!(w.snapshot(), before);
    assert_eq!(counters(&w, &mandate), (0, 0));
}

/// Mode 9: returns Ok and moves nothing.
#[test]
fn mode_9_noop_ok_succeeds_without_moving_anything() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::NoopOk));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(w.snapshot(), before);
        assert_eq!(delegate_of(&w.svm, &w.in_account).1, 5_000_000);
    });
}

/// Mode 10: takes the full input, pays `minimum_amount_out - 1`.
#[test]
fn mode_10_underpay_pays_one_less_than_the_minimum() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Underpay));
        let ix = w.swap_ix(AMOUNT_IN, 500_000);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - AMOUNT_IN);
        assert_eq!(amount(&w.svm, &w.out_account), 499_999);
        assert_eq!(amount(&w.svm, &w.out_vault), 1_000_000_000 - 499_999);
        // min_out = 0 underflows saturating: pays zero
        let ix = w.swap_ix(AMOUNT_IN, 0);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.out_account), 499_999);
    });
}

/// Mode 11: pulls `amount_in / 2` and pays the output for that smaller input.
#[test]
fn mode_11_pull_less_pulls_half_and_pays_proportionally() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::PullLess));
        let amount_in = 1_000_001u64;
        let pulled = amount_in / 2; // 500_000
        let out = amount_out(1_000_000_000, 1_000_000_000, pulled).unwrap();
        assert_eq!(out, 499_750);
        let ix = w.swap_ix(amount_in, 0);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - pulled);
        assert_eq!(amount(&w.svm, &w.in_vault), 1_000_000_000 + pulled);
        assert_eq!(amount(&w.svm, &w.out_account), out);
        assert_eq!(delegate_of(&w.svm, &w.in_account).1, 5_000_000 - pulled);
    });
}

/// Mode 12: spins until the compute budget runs out; nothing is left behind.
#[test]
fn mode_12_burn_cpu_exhausts_the_compute_budget() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::BurnCpu));
        let before = w.snapshot();
        let ix = w.swap_ix(AMOUNT_IN, 0);
        let f = w.send(&[ix]).expect_err("must fail");
        assert_eq!(
            format!("{:?}", f.err),
            "InstructionError(0, ProgramFailedToComplete)"
        );
        assert!(
            f.meta.logs.iter().any(|l| l.contains("exceeded CUs meter")),
            "{:#?}",
            f.meta.logs
        );
        assert_eq!(w.snapshot(), before);
    });
}

/// Every one of the 13 modes is covered by a test above; this guards the numbering.
#[test]
fn the_thirteen_modes_are_numbered_zero_to_twelve() {
    for (i, m) in [
        Mode::Normal,
        Mode::PullExtra,
        Mode::BurnIn,
        Mode::ApproveAttacker,
        Mode::SetAuth,
        Mode::CloseAccount,
        Mode::RedirectOutput,
        Mode::ReenterRelay,
        Mode::CpiVerify,
        Mode::NoopOk,
        Mode::Underpay,
        Mode::PullLess,
        Mode::BurnCpu,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(m as u8 as usize, i);
    }
}

// =============================================================================================
// proxy + init_pool
// =============================================================================================

#[test]
fn proxy_runs_the_inner_swap_at_stack_height_two() {
    each_flavour(|fl| {
        let mut w = World::new(fl, cfg(Mode::Normal));
        let inner = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        let outer = w.proxied(&inner);
        let meta = w.send(&[outer]).unwrap();
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);
        assert_eq!(amount(&w.svm, &w.in_account), 10_000_000 - AMOUNT_IN);
        let logs = meta.logs.join("\n");
        let m = mock().to_string();
        assert!(logs.contains(&format!("Program {m} invoke [1]")), "{logs}");
        assert!(logs.contains(&format!("Program {m} invoke [2]")), "{logs}");
        assert!(
            logs.contains(&format!("Program {} invoke [3]", w.tp)),
            "{logs}"
        );
    });
}

#[test]
fn proxy_preserves_signer_flags_and_rejects_bad_calls() {
    let mut w = World::new(Flavour::Classic, cfg(Mode::Normal));
    let inner = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
    // payer not a signer in the outer transaction: the inner CPI cannot gain the signature
    let mut outer = w.proxied(&inner);
    for m in outer.accounts.iter_mut() {
        if m.pubkey == w.payer.pubkey() {
            m.is_signer = false;
        }
    }
    let before = w.snapshot();
    assert!(w.send(&[outer]).is_err());
    assert_eq!(w.snapshot(), before);

    // no accounts at all
    let ix = Instruction::new_with_bytes(mock(), &mock_amm::PROXY_DISC, vec![]);
    assert_err_contains(w.send(&[ix]), "NotEnoughAccountKeys");

    // too many forwarded accounts
    let mut metas = vec![AccountMeta::new_readonly(mock(), false)];
    metas.extend((0..33).map(|_| AccountMeta::new_readonly(w.config, false)));
    let ix = Instruction::new_with_bytes(mock(), &mock_amm::PROXY_DISC, metas);
    assert_custom(w.send(&[ix]), &mock(), 7005);
}

#[test]
fn init_pool_creates_a_usable_pool_on_a_cluster_style_flow() {
    each_flavour(|fl| {
        let mut w = World::without_pool(fl, cfg(Mode::Normal));
        let rent = w.svm.minimum_balance_for_rent_exemption(104);
        let create = create_account_ix(&w.fee.pubkey(), &w.pool.pubkey(), rent, 104, &mock());
        let init = init_pool_ix(
            &w.pool.pubkey(),
            &w.in_vault,
            &w.out_vault,
            Mode::Normal as u8,
            &w.cfg.aux,
        );
        // the pool keypair must sign the CreateAccount
        let pool = w.pool.insecure_clone();
        w.send_with(&[create, init], &[&pool]).unwrap();

        let data = w.svm.get_account(&w.pool.pubkey()).unwrap().data;
        let state = PoolState::parse(&data).unwrap();
        assert_eq!(state.mode, Mode::Normal);
        assert_eq!(state.vault_0, w.in_vault.to_bytes());
        assert_eq!(state.vault_1, w.out_vault.to_bytes());
        assert_eq!(state.aux_key, w.cfg.aux.to_bytes());

        let ix = w.swap_ix(AMOUNT_IN, NORMAL_OUT);
        w.send(&[ix]).unwrap();
        assert_eq!(amount(&w.svm, &w.out_account), NORMAL_OUT);

        // second init on the same pool is refused
        let again = init_pool_ix(&w.pool.pubkey(), &w.in_vault, &w.out_vault, 0, &w.cfg.aux);
        assert_custom(w.send(&[again]), &mock(), 7002);
    });
}

#[test]
fn init_pool_rejects_bad_input() {
    let mut w = World::without_pool(Flavour::Classic, cfg(Mode::Normal));
    let rent = w.svm.minimum_balance_for_rent_exemption(104);
    // pool account owned by the mock and zeroed, created directly
    w.svm
        .set_account(
            w.pool.pubkey(),
            solana_account::Account {
                lamports: rent,
                data: vec![0u8; 104],
                owner: mock(),
                ..Default::default()
            },
        )
        .unwrap();
    let aux = w.cfg.aux;
    // undefined mode
    let ix = init_pool_ix(&w.pool.pubkey(), &w.in_vault, &w.out_vault, 13, &aux);
    assert_custom(w.send(&[ix]), &mock(), 7005);
    // identical vaults
    let ix = init_pool_ix(&w.pool.pubkey(), &w.in_vault, &w.in_vault, 0, &aux);
    assert_custom(w.send(&[ix]), &mock(), 7003);
    // short data
    let mut ix = init_pool_ix(&w.pool.pubkey(), &w.in_vault, &w.out_vault, 0, &aux);
    ix.data.pop();
    assert_custom(w.send(&[ix]), &mock(), 7005);
    // not owned by the mock
    let stranger = Pubkey::new_unique();
    w.svm
        .set_account(
            stranger,
            solana_account::Account {
                lamports: rent,
                data: vec![0u8; 104],
                owner: solana_sdk_ids::system_program::ID,
                ..Default::default()
            },
        )
        .unwrap();
    let ix = init_pool_ix(&stranger, &w.in_vault, &w.out_vault, 0, &aux);
    assert_custom(w.send(&[ix]), &mock(), 7002);
    // and the good call still works afterwards
    let ix = init_pool_ix(&w.pool.pubkey(), &w.in_vault, &w.out_vault, 0, &aux);
    w.send(&[ix]).unwrap();
}
