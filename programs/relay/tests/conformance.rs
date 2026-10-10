//! Host conformance tests: the program constants against the IDL, the core
//! crate and the byte-exact golden vectors (TEST-MATRIX FE-04, FE-06, FE-09,
//! CORE-12). No programs are loaded.

use agent_auth_relay::cpi::verify_data;
use agent_auth_relay::error::RelayError;
use agent_auth_relay::ids::*;
use agent_auth_relay::state::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;

fn idl() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../idl/relay-idl.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("idl/relay-idl.json")).unwrap()
}

fn golden(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(path).unwrap()
}

fn golden_hex(name: &str) -> Vec<u8> {
    let text = String::from_utf8(golden(name)).unwrap();
    (0..text.trim().len() / 2)
        .map(|i| u8::from_str_radix(&text.trim()[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn b58(k: &[u8; 32]) -> String {
    Pubkey::from(*k).to_string()
}

/// CORE-12: the mandate offsets the relay reads equal the core crate's.
#[test]
fn mandate_offsets_match_core_crate() {
    assert_eq!(MANDATE_OFF_DISC, agent_auth::OFF_DISC);
    assert_eq!(MANDATE_OFF_OWNER, agent_auth::OFF_OWNER);
    assert_eq!(MANDATE_OFF_AGENT, agent_auth::OFF_AGENT);
    assert_eq!(MANDATE_OFF_EXPIRY, agent_auth::OFF_EXPIRY);
    assert_eq!(MANDATE_OFF_ACTIVE, agent_auth::OFF_ACTIVE);
    assert_eq!(MANDATE_LEN, agent_auth::ACCOUNT_SIZE);
    assert_eq!(MANDATE_DISC, agent_auth::MANDATE_DISCRIMINATOR);
}

/// The compiled AgentAuth id is the core crate's `declare_id!`.
#[test]
fn agent_auth_id_matches_core_crate() {
    assert_eq!(AGENT_AUTH_ID, agent_auth::ID);
}

/// FE-04: error enum equals the IDL, names and numbers.
#[test]
fn errors_match_idl() {
    let idl = idl();
    let errors = idl["errors"].as_array().unwrap();
    assert_eq!(errors.len(), RelayError::ALL.len());
    for (e, j) in RelayError::ALL.iter().zip(errors) {
        assert_eq!(j["code"].as_u64().unwrap(), u64::from(e.code()));
        assert_eq!(j["name"].as_str().unwrap(), format!("{e:?}"));
    }
}

/// FE-06: every RelayPolicy field offset/size in the IDL equals the program
/// constants, and the fields tile the 944 bytes with no gap or overlap.
#[test]
fn policy_layout_matches_idl() {
    let idl = idl();
    let acct = &idl["accounts"][0];
    assert_eq!(acct["name"], "RelayPolicy");
    assert_eq!(acct["size"].as_u64().unwrap() as usize, POLICY_LEN);
    assert_eq!(
        acct["discriminator"]["value"].as_u64().unwrap() as u8,
        POLICY_DISC
    );
    let expected: &[(&str, usize)] = &[
        ("disc", OFF_DISC),
        ("version", OFF_VERSION),
        ("policy_bump", OFF_POLICY_BUMP),
        ("authority_bump", OFF_AUTHORITY_BUMP),
        ("flags", OFF_FLAGS),
        ("reserved0", 5),
        ("mandate", OFF_MANDATE),
        ("owner", OFF_OWNER),
        ("agent", OFF_AGENT),
        ("authority", OFF_AUTHORITY),
        ("mandate_expiry", OFF_MANDATE_EXPIRY),
        ("token_program", OFF_TOKEN_PROGRAM),
        ("budget_mint", OFF_BUDGET_MINT),
        ("source_account", OFF_SOURCE),
        ("recipients_len", OFF_RECIPIENTS_LEN),
        ("swap_enabled", OFF_SWAP_ENABLED),
        ("reserved1", 242),
        ("recipients", OFF_RECIPIENTS),
        ("amm_program", OFF_AMM_PROGRAM),
        ("amm_authority", OFF_AMM_AUTHORITY),
        ("amm_config", OFF_AMM_CONFIG),
        ("pool_state", OFF_POOL_STATE),
        ("input_vault", OFF_INPUT_VAULT),
        ("output_vault", OFF_OUTPUT_VAULT),
        ("observation_state", OFF_OBSERVATION_STATE),
        ("in_mint", OFF_IN_MINT),
        ("out_mint", OFF_OUT_MINT),
        ("in_token_program", OFF_IN_TOKEN_PROGRAM),
        ("out_token_program", OFF_OUT_TOKEN_PROGRAM),
        ("in_account", OFF_IN_ACCOUNT),
        ("out_account", OFF_OUT_ACCOUNT),
        ("floor_out", OFF_FLOOR_OUT),
        ("floor_in", OFF_FLOOR_IN),
        ("max_deadline_slots", OFF_MAX_DEADLINE_SLOTS),
        ("reserved2", OFF_RESERVED2),
    ];
    let fields = acct["fields"].as_array().unwrap();
    assert_eq!(fields.len(), expected.len());
    let mut next = 0usize;
    for (f, (name, off)) in fields.iter().zip(expected) {
        assert_eq!(f["name"].as_str().unwrap(), *name);
        assert_eq!(f["offset"].as_u64().unwrap() as usize, *off, "{name}");
        assert_eq!(
            *off, next,
            "{name} must start where the previous field ended"
        );
        next = off + f["size"].as_u64().unwrap() as usize;
    }
    assert_eq!(next, POLICY_LEN);
    assert_eq!(CONFIG_OFF + CONFIG_LEN, POLICY_LEN);
    assert_eq!(CONFIG_OFF, OFF_TOKEN_PROGRAM);
}

/// FE-09: exact account counts, data lengths, tags and signer positions.
#[test]
fn instructions_match_idl() {
    let idl = idl();
    let want: &[(&str, u64, usize, u64, &[usize])] = &[
        ("init_policy", u64::from(TAG_INIT_POLICY), 4, 802, &[0]),
        ("set_paused", u64::from(TAG_SET_PAUSED), 2, 2, &[0]),
        ("close_policy", u64::from(TAG_CLOSE_POLICY), 2, 1, &[0]),
        ("transfer", u64::from(TAG_TRANSFER), 10, 9, &[0]),
        ("swap", u64::from(TAG_SWAP), 19, 25, &[0]),
    ];
    let ixs = idl["instructions"].as_array().unwrap();
    assert_eq!(ixs.len(), want.len());
    for (ix, (name, tag, accounts, len, signers)) in ixs.iter().zip(want) {
        assert_eq!(ix["name"], *name);
        assert_eq!(ix["tag"].as_u64().unwrap(), *tag, "{name}");
        assert_eq!(
            ix["accounts"].as_array().unwrap().len(),
            *accounts,
            "{name}"
        );
        assert_eq!(ix["dataLength"].as_u64().unwrap(), *len, "{name}");
        let got: Vec<usize> = ix["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, a)| a["isSigner"].as_bool().unwrap())
            .map(|(i, _)| i)
            .collect();
        assert_eq!(&got, signers, "{name} signer positions");
    }
    assert_eq!(agent_auth_relay::ix::init_policy::INIT_DATA_LEN, 802);
    assert_eq!(agent_auth_relay::ix::transfer::TRANSFER_DATA_LEN, 9);
    assert_eq!(agent_auth_relay::ix::swap::SWAP_DATA_LEN, 25);
    assert_eq!(agent_auth_relay::ix::swap::SWAP_ACCOUNTS, 19);
}

/// The ids and discriminators in the IDL constants equal the compiled ones.
#[test]
fn ids_match_idl_and_decode_to_base58() {
    let idl = idl();
    let ids = &idl["constants"]["programIds"];
    assert_eq!(b58(&TOKEN_ID), ids["token"]);
    assert_eq!(b58(&TOKEN22_ID), ids["token2022"]);
    assert_eq!(b58(&SYSTEM_ID), ids["system"]);
    assert_eq!(b58(&NATIVE_MINT), ids["nativeMint"]);
    assert_eq!(b58(&AGENT_AUTH_ID), ids["agentAuth"]);
    assert_eq!(b58(&CPMM_MAINNET_ID), ids["raydiumCpmmMainnet"]);
    assert_eq!(b58(&CPMM_DEVNET_ID), ids["raydiumCpmmDevnet"]);
    assert_eq!(b58(&MOCK_AMM_ID), idl["addresses"]["mock_amm"]["devnet"]);
    let discs = &idl["constants"]["discriminators"];
    let hex = |d: &[u8; 8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(hex(&TRANSFER_CHECKED_DISC), discs["transferChecked"]);
    assert_eq!(hex(&SWAP_DISC), discs["raydiumSwapBaseInput"]);
    // Anchor rule: first 8 bytes of sha256("global:swap_base_input").
    assert_eq!(&Sha256::digest(b"global:swap_base_input")[..8], &SWAP_DISC);
    assert_eq!(idl["constants"]["policy"]["size"], POLICY_LEN);
    assert_eq!(idl["constants"]["policy"]["disc"], POLICY_DISC);
    assert_eq!(
        idl["constants"]["policy"]["maxDeadlineSlotsCap"],
        MAX_DEADLINE_SLOTS_CAP
    );
}

/// AMM allowlist per cargo feature (RELAY-SPEC section 4).
#[test]
fn amm_allowlist_follows_features() {
    assert_eq!(amm_allowed(&CPMM_DEVNET_ID), cfg!(feature = "devnet"));
    assert_eq!(amm_allowed(&CPMM_MAINNET_ID), !cfg!(feature = "devnet"));
    assert_eq!(amm_allowed(&MOCK_AMM_ID), cfg!(feature = "test-amm"));
    assert!(!amm_allowed(&[7u8; 32]));
    assert!(!amm_allowed(&[0u8; 32]));
}

/// The golden policy decodes to the documented values through the one parser
/// shared by `init_policy` and the stored policy, and re-encodes identically.
#[test]
fn golden_policy_round_trips() {
    let bin = golden("policy_example.bin");
    assert_eq!(bin.len(), POLICY_LEN);
    let p = Policy::new(&bin).unwrap();
    let c = p.config();
    assert_eq!(p.disc(), POLICY_DISC);
    assert_eq!(p.version(), 1);
    assert_eq!(p.flags(), FLAG_STRICT_TOP_LEVEL);
    assert_eq!(p.authority_bump(), 253);
    assert_eq!(p.mandate(), &[0x11; 32]);
    assert_eq!(p.owner(), &[0x22; 32]);
    assert_eq!(p.agent(), &[0x33; 32]);
    assert_eq!(p.authority(), &[0x44; 32]);
    assert_eq!(p.mandate_expiry_bytes(), &1_800_000_000i64.to_le_bytes());
    assert_eq!(c.token_program(), &TOKEN_ID);
    assert_eq!(c.budget_mint(), &[0x55; 32]);
    assert_eq!(c.source_account(), &[0x66; 32]);
    assert_eq!(c.recipients_len(), 1);
    assert!(c.is_recipient(&[0x61; 32]));
    assert!(!c.is_recipient(&[0x62; 32]));
    assert_eq!(c.swap_enabled(), 1);
    assert_eq!(c.amm_program(), &[0x71; 32]);
    assert_eq!(c.amm_authority(), &[0x72; 32]);
    assert_eq!(c.amm_config(), &[0x73; 32]);
    assert_eq!(c.pool_state(), &[0x74; 32]);
    assert_eq!(c.input_vault(), &[0x75; 32]);
    assert_eq!(c.output_vault(), &[0x76; 32]);
    assert_eq!(c.observation_state(), &[0x77; 32]);
    assert_eq!(c.in_mint(), &[0x78; 32]);
    assert_eq!(c.out_mint(), &[0x79; 32]);
    assert_eq!(c.in_token_program(), &TOKEN_ID);
    assert_eq!(c.out_token_program(), &TOKEN_ID);
    assert_eq!(c.in_account(), &[0x66; 32]);
    assert_eq!(c.out_account(), &[0x7a; 32]);
    assert_eq!(c.floor_out(), 95);
    assert_eq!(c.floor_in(), 100);
    assert_eq!(c.max_deadline_slots(), 150);

    // Re-encode: header fields + the config region.
    let mut out = vec![0u8; POLICY_LEN];
    let h = Header {
        policy_bump: bin[OFF_POLICY_BUMP],
        authority_bump: p.authority_bump(),
        flags: p.flags(),
        mandate: p.mandate(),
        owner: p.owner(),
        agent: p.agent(),
        authority: p.authority(),
        mandate_expiry: p.mandate_expiry_bytes(),
    };
    write_policy(&mut out, &h, c.as_bytes()).unwrap();
    assert_eq!(out, bin);
}

/// The golden `init_policy` data is `[0, flags, config]` with the config equal
/// to `policy[144..944]` (one parser for both).
#[test]
fn golden_init_data_matches_policy_config() {
    let data = golden_hex("init_policy_ix_data.hex");
    let bin = golden("policy_example.bin");
    assert_eq!(data.len(), 802);
    assert_eq!(data[0], TAG_INIT_POLICY);
    assert_eq!(data[1], bin[OFF_FLAGS]);
    assert_eq!(&data[2..], &bin[CONFIG_OFF..]);
}

/// NOTE (spec/golden inconsistency, reported): the golden example is a layout
/// vector, not an acceptable config. Its AMM id is a fake key and, with
/// `in_account == source_account`, its `in_mint` (0x78) differs from the
/// `budget_mint` (0x55), which RELAY-SPEC 5.2 forbids. With the allowlist
/// check relaxed and that one field aligned, it validates.
#[test]
fn golden_config_is_a_layout_vector_not_a_valid_config() {
    let data = golden_hex("init_policy_ix_data.hex");
    let id = IdentityKeys {
        mandate: &[0x11; 32],
        policy: &[0x12; 32],
        authority: &[0x44; 32],
        owner: &[0x22; 32],
        agent: &[0x33; 32],
    };
    let any_amm: fn(&[u8; 32]) -> bool = |_| true;
    let cfg = Config::new(&data[2..]).unwrap();
    assert_eq!(cfg.validate(&id, any_amm), Err(RelayError::InvalidConfig));

    let mut fixed = data[2..].to_vec();
    let off = OFF_IN_MINT - CONFIG_OFF;
    fixed[off..off + 32].copy_from_slice(&[0x55; 32]);
    let cfg = Config::new(&fixed).unwrap();
    assert_eq!(cfg.validate(&id, any_amm), Ok(()));
    // ... and the real (feature-gated) allowlist still rejects the fake AMM.
    assert_eq!(
        cfg.validate(&id, amm_allowed),
        Err(RelayError::InvalidConfig)
    );
}

/// `verify` data for the golden transfer equals the golden hex (FE-07, Rust half).
#[test]
fn golden_verify_data() {
    let want = golden_hex("verify_ix_data.hex");
    let amount = u64::from_le_bytes(golden_hex("transfer_ix_data.hex")[1..9].try_into().unwrap());
    assert_eq!(
        verify_data(&TOKEN_ID, &TRANSFER_CHECKED_DISC, amount).to_vec(),
        want
    );
}
