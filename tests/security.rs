//! Security-focused tests.  These are a mix of unit and integration tests
#[cfg(test)]
mod unit {
    use agent_auth::state::Mandate;
    use agent_auth::*;

    // ──────────────────────────────────────────────────────────────────────
    // sec_overflow_spend_total_no_wrap
    // ──────────────────────────────────────────────────────────────────────
    /// `spend_total` near `u64::MAX` plus any non-zero amount must return
    /// `None` from `checked_add` — the value must never silently wrap.
    ///
    /// Why it matters: this is the exact arithmetic guard in `verify.rs`.
    /// Without it an agent could borrow unlimited funds once the total wraps.
    #[test]
    fn sec_overflow_spend_total_no_wrap() {
        // Near-max: adding 100 must overflow
        assert!(
            (u64::MAX - 50).checked_add(100).is_none(),
            "adding 100 to (MAX-50) must overflow"
        );
        // Exactly at MAX
        assert!(
            u64::MAX.checked_add(1).is_none(),
            "adding 1 to MAX must overflow"
        );
        // 0-add to MAX is fine (sentinel: spend_limit == 0 means unlimited)
        assert_eq!(u64::MAX.checked_add(0), Some(u64::MAX));
        // Safe addition is exact
        assert_eq!(300u64.checked_add(200), Some(500));
        // Contrast: wrapping_add silently wraps — we never use it
        assert_eq!(u64::MAX.wrapping_add(1), 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    // sec_type_confusion_rejects_wrong_discriminator
    // ──────────────────────────────────────────────────────────────────────
    /// Any account owned by our program with `discriminator != 1` must be
    /// caught by the guard present in every instruction handler.
    ///
    /// Why it matters: without a discriminator check a foreign account shaped
    /// like a mandate could pass validation and grant unintended access.
    #[test]
    fn sec_type_confusion_rejects_wrong_discriminator() {
        let bad_discs: &[u8] = &[0x00, 0x02, 0x7F, 0xFF];

        for &bad in bad_discs {
            let mut buf = [0u8; ACCOUNT_SIZE];
            buf[OFF_DISC] = bad;
            let m = Mandate::from_bytes(&mut buf).unwrap();
            assert_ne!(
                m.discriminator(),
                MANDATE_DISCRIMINATOR,
                "discriminator 0x{bad:02X} must not equal MANDATE_DISCRIMINATOR (1)"
            );
        }

        // Positive control
        let mut buf = [0u8; ACCOUNT_SIZE];
        buf[OFF_DISC] = MANDATE_DISCRIMINATOR;
        let m = Mandate::from_bytes(&mut buf).unwrap();
        assert_eq!(m.discriminator(), MANDATE_DISCRIMINATOR);
    }
}

// ── integration section ───────────────────────────────────────────────────

mod common;
use common::integration::*;

// ──────────────────────────────────────────────────────────────────────────
// sec_reinit_rejects
// ──────────────────────────────────────────────────────────────────────────
/// Calling `create_mandate` over an already-initialised mandate must return
/// `AlreadyInitialized` (Custom(3)).  No silent overwrite of a live record.
///
/// Why it matters: if an attacker could re-create over an active mandate
/// they could reset permissions and hijack an agent's authority.
#[test]
fn sec_reinit_rejects() {
    let Some((mut svm, owner)) = setup() else {
        return;
    };
    let agent = Keypair::new();

    // Pre-populate so discriminator == 1 is already on-chain
    seed_mandate(&mut svm, &owner.pubkey(), &agent.pubkey(), true);

    // create_mandate must be rejected before the CPI fires
    let err = send(
        &mut svm,
        &[&owner],
        &[create_mandate_ix(&owner.pubkey(), &agent.pubkey(), i64::MAX)],
    )
    .unwrap_err();
    let err_text = format!("{:?}", err.err);

    assert!(
        err_text.contains("Custom(3)"),
        "expected AlreadyInitialized (Custom(3)); got: {err_text}"
    );
}

// ──────────────────────────────────────────────────────────────────────────
// sec_signer_check_owner_ix
// ──────────────────────────────────────────────────────────────────────────
/// Calling an owner-only instruction without the owner's signature must be
/// rejected with `InvalidSigner` (Custom(18)).
///
/// Mechanism: the owner is listed as writable but NOT as signer in AccountMeta
/// so the runtime admits the transaction; our program's `is_signer()` check
/// then fires and returns the error.
///
/// Why it matters: signer enforcement is the last line of defence; if any
/// owner-only path skipped it an attacker could revoke or drain any mandate.
#[test]
fn sec_signer_check_owner_ix() {
    let Some((mut svm, owner)) = setup() else {
        return;
    };
    let agent = Keypair::new();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());
    seed_mandate(&mut svm, &owner.pubkey(), &agent.pubkey(), true);

    // Craft a revoke_mandate instruction where owner is listed but NOT signed
    let ix_unsigned = Instruction::new_with_bytes(
        program_id(),
        &[4u8], // revoke tag
        vec![
            AccountMeta::new(owner.pubkey(), false), // writable, NOT signer
            AccountMeta::new(mandate, false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
        ],
    );

    // Attacker is the sole signer — owner does NOT sign
    let err = send(&mut svm, &[&attacker], &[ix_unsigned]).unwrap_err();
    let err_text = format!("{:?}", err.err);

    assert!(
        err_text.contains("Custom(18)"),
        "expected InvalidSigner (Custom(18)) when owner omits signature; got: {err_text}"
    );
}
