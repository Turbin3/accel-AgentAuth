//! Golden-vector self-tests: the harness encoders must produce the byte-exact vectors of the
//! design package (`golden/`, copied next to this file). No `.so` needed.

use super::*;

const INIT_HEX: &str = include_str!("golden/init_policy_ix_data.hex");
const TRANSFER_HEX: &str = include_str!("golden/transfer_ix_data.hex");
const SWAP_HEX: &str = include_str!("golden/swap_ix_data.hex");
const VERIFY_HEX: &str = include_str!("golden/verify_ix_data.hex");
const POLICY_BIN: &[u8] = include_bytes!("golden/policy_example.bin");

/// Optional drift check against the design package's golden files: set `AA_DESIGN_GOLDEN_DIR` to the
/// directory that holds them (the design package is not part of this repository).
const DESIGN_GOLDEN_DIR_ENV: &str = "AA_DESIGN_GOLDEN_DIR";

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim();
    assert_eq!(s.len() % 2, 0, "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex digit"))
        .collect()
}

fn k(b: u8) -> Pubkey {
    Pubkey::new_from_array([b; 32])
}

/// The config of `golden/policy_example.json` (fake keys are 32 repeated bytes).
fn example_cfg() -> PolicyCfg {
    PolicyCfg::transfer_only(TOKEN_ID, k(0x55), k(0x66), &[k(0x61)]).with_swap(&SwapPins {
        amm_program: k(0x71),
        amm_authority: k(0x72),
        amm_config: k(0x73),
        pool_state: k(0x74),
        input_vault: k(0x75),
        output_vault: k(0x76),
        observation_state: k(0x77),
        in_mint: k(0x78),
        out_mint: k(0x79),
        in_token_program: TOKEN_ID,
        out_token_program: TOKEN_ID,
        in_account: k(0x66),
        out_account: k(0x7a),
        floor_out: 95,
        floor_in: 100,
        max_deadline_slots: 150,
    })
}

fn example_header() -> PolicyHeader {
    PolicyHeader {
        policy_bump: 254,
        authority_bump: 253,
        flags: 2,
        mandate: k(0x11),
        owner: k(0x22),
        agent: k(0x33),
        authority: k(0x44),
        mandate_expiry: 1_800_000_000,
    }
}

#[test]
fn init_policy_instruction_data_is_byte_exact() {
    let want = hex_decode(INIT_HEX);
    assert_eq!(want.len(), policy::INIT_DATA_LEN);
    assert_eq!(example_cfg().init_data(2), want);
}

#[test]
fn full_policy_account_is_byte_exact() {
    let got = example_header().encode_with(&example_cfg());
    assert_eq!(got.len(), policy::POLICY_LEN);
    assert_eq!(
        got.as_slice(),
        POLICY_BIN,
        "policy bytes drifted from golden/policy_example.bin"
    );
}

#[test]
fn golden_policy_round_trips_through_the_decoder() {
    let v = PolicyView::decode(POLICY_BIN);
    assert_eq!(v.disc, policy::POLICY_DISC);
    assert_eq!(v.version, policy::POLICY_VERSION);
    assert_eq!(v.header, example_header());
    assert_eq!(v.cfg, example_cfg());
    assert!(!v.paused());
    // re-encode equals the original
    assert_eq!(v.header.encode_with(&v.cfg).as_slice(), POLICY_BIN);
}

#[test]
fn config_region_is_bytes_2_to_802_of_the_instruction_data() {
    let data = example_cfg().init_data(2);
    assert_eq!(&data[2..], &POLICY_BIN[policy::CONFIG_OFFSET..]);
    assert_eq!(data[0], relay_ix::TAG_INIT_POLICY);
    assert_eq!(data[1], 2);
}

#[test]
fn transfer_instruction_data_is_byte_exact() {
    assert_eq!(relay_ix::transfer_data(3_000_000), hex_decode(TRANSFER_HEX));
    let t = TransferIx {
        program: RELAY_ID,
        agent: k(1),
        mandate: k(2),
        owner: k(3),
        policy: k(4),
        authority: k(5),
        source: k(6),
        destination: k(7),
        mint: k(8),
        token_program: TOKEN_ID,
        agentauth_program: AGENT_AUTH_ID,
    };
    assert_eq!(t.ix(3_000_000).data, hex_decode(TRANSFER_HEX));
}

#[test]
fn swap_instruction_data_is_byte_exact() {
    let want = hex_decode(SWAP_HEX);
    assert_eq!(want.len(), relay_ix::SWAP_DATA_LEN);
    assert_eq!(relay_ix::swap_data(5_000_000, 0, 123_456_789), want);
}

#[test]
fn verify_instruction_data_is_byte_exact() {
    // verify_ix_data_for_transfer: token program id, TransferChecked disc, amount 3_000_000.
    let ix = aa::verify_ix(
        &k(1),
        &k(2),
        &k(3),
        &TOKEN_ID,
        &TRANSFER_CHECKED_DISC,
        3_000_000,
    );
    assert_eq!(ix.data, hex_decode(VERIFY_HEX));
    assert_eq!(ix.data.len(), 49);
    // locked ABI: accounts [mandate W, owner R, agent R+S]
    assert!(ix.accounts[0].is_writable && !ix.accounts[0].is_signer);
    assert!(!ix.accounts[1].is_writable && !ix.accounts[1].is_signer);
    assert!(!ix.accounts[2].is_writable && ix.accounts[2].is_signer);
}

#[test]
fn floor_math_matches_the_golden_example() {
    // golden/policy_example.json: swap_required_min_out_for_5000000_in = 4750000
    assert_eq!(required_min_out(5_000_000, 95, 100), Some(4_750_000));
    // ceil, not floor
    assert_eq!(required_min_out(1, 95, 100), Some(1));
    // does not fit in u64
    assert_eq!(required_min_out(u64::MAX, u64::MAX, 1), None);
}

#[test]
fn instruction_builders_have_the_exact_account_counts_and_flags() {
    let t = TransferIx {
        program: RELAY_ID,
        agent: k(1),
        mandate: k(2),
        owner: k(3),
        policy: k(4),
        authority: k(5),
        source: k(6),
        destination: k(7),
        mint: k(8),
        token_program: TOKEN_ID,
        agentauth_program: AGENT_AUTH_ID,
    }
    .ix(1);
    assert_eq!(t.accounts.len(), relay_ix::TRANSFER_ACCOUNTS);
    let flags: Vec<(bool, bool)> = t
        .accounts
        .iter()
        .map(|a| (a.is_signer, a.is_writable))
        .collect();
    // agent S, mandate W, owner, policy, authority, source W, destination W, mint, token prog, aa prog
    assert_eq!(
        flags,
        vec![
            (true, false),
            (false, true),
            (false, false),
            (false, false),
            (false, false),
            (false, true),
            (false, true),
            (false, false),
            (false, false),
            (false, false)
        ]
    );

    let s = SwapIx {
        program: RELAY_ID,
        agent: k(1),
        mandate: k(2),
        owner: k(3),
        policy: k(4),
        authority: k(5),
        in_account: k(6),
        out_account: k(7),
        amm_program: k(8),
        amm_authority: k(9),
        amm_config: k(10),
        pool_state: k(11),
        input_vault: k(12),
        output_vault: k(13),
        in_token_program: k(14),
        out_token_program: k(15),
        in_mint: k(16),
        out_mint: k(17),
        observation_state: k(18),
        agentauth_program: AGENT_AUTH_ID,
    }
    .ix(1, 2, 3);
    assert_eq!(s.accounts.len(), relay_ix::SWAP_ACCOUNTS);
    let writable: Vec<usize> = s
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.is_writable)
        .map(|(i, _)| i)
        .collect();
    use swap_idx::*;
    assert_eq!(
        writable,
        vec![
            MANDATE,
            IN_ACCOUNT,
            OUT_ACCOUNT,
            POOL_STATE,
            INPUT_VAULT,
            OUTPUT_VAULT,
            OBSERVATION_STATE
        ]
    );
    assert!(s.accounts[AGENT].is_signer);
    assert_eq!(s.data.len(), relay_ix::SWAP_DATA_LEN);

    let init = InitPolicyIx::new(k(1), k(2), k(3)).ix(&example_cfg().init_data(0));
    assert_eq!(init.accounts.len(), relay_ix::INIT_POLICY_ACCOUNTS);
    assert!(init.accounts[init_idx::OWNER].is_signer && init.accounts[init_idx::OWNER].is_writable);
    assert!(!init.accounts[init_idx::MANDATE].is_writable);
    assert!(init.accounts[init_idx::POLICY].is_writable);
    assert_eq!(
        relay_ix::set_paused_ix(&k(1), &k(2), 1).accounts.len(),
        relay_ix::SET_PAUSED_ACCOUNTS
    );
    assert_eq!(
        relay_ix::close_policy_ix(&k(1), &k(2)).accounts.len(),
        relay_ix::CLOSE_POLICY_ACCOUNTS
    );
}

#[test]
fn ix_ext_corrupts_exactly_one_thing() {
    let base = TransferIx {
        program: RELAY_ID,
        agent: k(1),
        mandate: k(2),
        owner: k(3),
        policy: k(4),
        authority: k(5),
        source: k(6),
        destination: k(7),
        mint: k(8),
        token_program: TOKEN_ID,
        agentauth_program: AGENT_AUTH_ID,
    }
    .ix(10);
    let c = base.clone().with_account(transfer_idx::DESTINATION, k(99));
    assert_eq!(c.accounts[transfer_idx::DESTINATION].pubkey, k(99));
    assert!(
        c.accounts[transfer_idx::DESTINATION].is_writable,
        "flags must be kept"
    );
    assert_eq!(c.data, base.data);
    assert_eq!(base.clone().truncate_accounts(9).accounts.len(), 9);
    assert_eq!(base.clone().with_extra_account(k(5)).accounts.len(), 11);
    assert_eq!(base.clone().truncate_data(8).data.len(), 8);
    assert!(
        !base
            .clone()
            .with_signer(transfer_idx::AGENT, false)
            .accounts[0]
            .is_signer
    );
    assert_eq!(base.clone().patch_data(1, &[0; 8]).data[1..], [0u8; 8]);
}

#[test]
fn local_golden_copies_equal_the_design_package() {
    let Some(dir) = std::env::var_os(DESIGN_GOLDEN_DIR_ENV).map(std::path::PathBuf::from) else {
        eprintln!("{DESIGN_GOLDEN_DIR_ENV} not set; skipping the design-package drift check");
        return;
    };
    assert!(
        dir.is_dir(),
        "{DESIGN_GOLDEN_DIR_ENV} is set but is not a directory: {dir:?}"
    );
    for (name, local) in [
        ("init_policy_ix_data.hex", INIT_HEX.as_bytes()),
        ("transfer_ix_data.hex", TRANSFER_HEX.as_bytes()),
        ("swap_ix_data.hex", SWAP_HEX.as_bytes()),
        ("verify_ix_data.hex", VERIFY_HEX.as_bytes()),
        ("policy_example.bin", POLICY_BIN),
    ] {
        let original = std::fs::read(dir.join(name)).expect("read design golden file");
        assert_eq!(original, local, "{name} drifted from the design package");
    }
}
