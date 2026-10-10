use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use super::{authorize_owner_accounts, open_mandate, require_owner};
use crate::error::MandateError;

/// Pause (`0`) or resume (`1`) a mandate without destroying it.
///
/// Accounts: `[owner (signer), mandate (writable)]`.
/// Data (after the tag): one byte, `0` or `1`.
///
/// While paused, `verify` fails with `NotActive` and `add_permission`,
/// `remove_permission` and `update_permission` are refused; permissions and
/// counters are preserved. This works on a paused mandate too, so the owner can
/// always resume. `revoke_mandate` stays the destructive kill switch.
pub fn set_active(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [owner, mandate_account, ..] = accounts else {
        return Err(MandateError::InvalidInstructionData.into());
    };
    let active = match data {
        [0] => false,
        [1] => true,
        _ => return Err(MandateError::InvalidInstructionData.into()),
    };

    authorize_owner_accounts(program_id, owner, mandate_account)?;
    let mut account_data = mandate_account.try_borrow_mut_data()?;
    let mut mandate = open_mandate(&mut account_data)?;
    require_owner(&mandate, owner)?;

    mandate.set_active(active);
    Ok(())
}
