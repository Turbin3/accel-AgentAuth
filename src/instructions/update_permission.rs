use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use super::{
    authorize_owner_accounts, expect_end, open_mandate, require_active, require_owner, take_pubkey,
    take_u64,
};
use crate::error::MandateError;

/// Replace the spend limit and per-transaction limit of an existing slot.
///
/// Accounts: `[owner (signer), mandate (writable)]`.
/// Data (after the tag): `program_id[32] | spend_limit u64 | per_tx_limit u64`,
/// nothing after.
///
/// `spend_total`, `call_count` and the discriminator list are preserved, so
/// changing a limit never hands the agent a fresh budget. Limits of 0 mean
/// **unlimited**. Lowering `spend_limit` below the current `spend_total`
/// blocks the slot until the owner raises it again. Does not change the
/// mandate's expiry: to change the lifetime, revoke and create again.
pub fn update_permission(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [owner, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };

    let (target_program, rest) = take_pubkey(data)?;
    let (spend_limit, rest) = take_u64(rest)?;
    let (per_tx_limit, rest) = take_u64(rest)?;
    expect_end(rest)?;

    authorize_owner_accounts(program_id, owner, mandate_account)?;
    let mut account_data = mandate_account.try_borrow_mut_data()?;
    let mut mandate = open_mandate(&mut account_data)?;
    require_owner(&mandate, owner)?;
    require_active(&mandate)?;

    let index = mandate
        .find_permission(target_program)
        .ok_or(MandateError::PermissionNotFound)?;
    let mut permission = mandate.permission_mut(index);
    permission.set_spend_limit(spend_limit);
    permission.set_per_tx_limit(per_tx_limit);
    Ok(())
}
