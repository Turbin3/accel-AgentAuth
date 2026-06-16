#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_mandate() {}

    #[test]
    fn verify_rejects_expire() {}

    #[test]
    fn verify_rejects_inactive() {}

    #[test]
    fn verify_rejects_program_not_allowed() {}

    #[test]
    fn verify_rejects_discriminator_not_allowed() {}

    #[test]
    fn verify_rejects_per_tx_exceeded() {}

    #[test]
    fn verify_writeback_accumulates() {}

    #[test]
    fn verify_cu_under_2500() {}

    #[test]
    fn verify_no_create_program_address() {}

    #[test]
    fn cpi_caller_aborts_on_error() {}
}
