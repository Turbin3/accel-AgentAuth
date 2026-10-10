//! `idl/core-idl.json` is the source of truth for the SDK, CLI and MCP server.
//! These tests fail if it and the program drift apart.

use agent_auth::*;
use serde_json::Value;

fn idl() -> Value {
    serde_json::from_str(include_str!("../idl/core-idl.json")).unwrap()
}

#[test]
fn constants_match() {
    let idl = idl();
    let c = &idl["constants"];
    let want = [
        ("accountSize", ACCOUNT_SIZE),
        ("headerSize", HEADER_SIZE),
        ("permissionSize", PERMISSION_SIZE),
        ("maxPermissions", MAX_PERMISSIONS),
        ("maxDiscriminators", MAX_DISCRIMINATORS),
        ("mandateDiscriminator", MANDATE_DISCRIMINATOR as usize),
        ("versionOffset", OFF_VERSION),
        ("bumpOffset", OFF_BUMP),
        ("currentVersion", CURRENT_VERSION as usize),
    ];
    for (key, value) in want {
        assert_eq!(c[key].as_u64(), Some(value as u64), "constants.{key}");
    }
    assert_eq!(c["mandateSeed"].as_str().unwrap().as_bytes(), MANDATE_SEED);
}

#[test]
fn error_codes_match() {
    use MandateError::*;
    let all = [
        InvalidDiscriminator,
        NotOwner,
        AlreadyInitialized,
        NotActive,
        Expired,
        ProgramNotAllowed,
        DiscriminatorNotAllowed,
        PerTxExceeded,
        SpendLimitExceeded,
        PermissionsFull,
        TooManyDiscriminators,
        PermissionNotFound,
        ArithmeticOverflow,
        AccountOwnerMismatch,
        InvalidInstructionData,
        InvalidAccountType,
        UnknownAgent,
        InvalidSigner,
        InvalidAgent,
        InvalidExpiry,
        DuplicatePermission,
        EmptyDiscriminators,
    ];
    let idl = idl();
    let errors = idl["errors"].as_array().unwrap();
    assert_eq!(errors.len(), all.len());
    for e in all {
        let name = format!("{e:?}");
        let entry = errors
            .iter()
            .find(|x| x["name"] == name.as_str())
            .unwrap_or_else(|| panic!("{name} missing from the IDL"));
        assert_eq!(entry["code"].as_u64(), Some(e as u64), "{name}");
    }
}

#[test]
fn instruction_tags_match() {
    let idl = idl();
    let tags: Vec<(String, u64)> = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["name"].as_str().unwrap().to_string(),
                i["tag"].as_u64().unwrap(),
            )
        })
        .collect();
    let want = [
        ("create_mandate", 0),
        ("add_permission", 1),
        ("remove_permission", 2),
        ("verify", 3),
        ("revoke_mandate", 4),
        ("set_active", 5),
        ("update_permission", 6),
    ];
    assert_eq!(tags.len(), want.len());
    for (name, tag) in want {
        assert!(
            tags.contains(&(name.to_string(), tag)),
            "{name} should be tag {tag}"
        );
    }
}

#[test]
fn header_and_slot_field_offsets_match() {
    let idl = idl();
    let account = &idl["accounts"][0];
    let header = [
        ("disc", OFF_DISC),
        ("owner", OFF_OWNER),
        ("agent", OFF_AGENT),
        ("expiry", OFF_EXPIRY),
        ("active", OFF_ACTIVE),
        ("permissions_len", OFF_PERM_LEN),
        ("version", OFF_VERSION),
        ("bump", OFF_BUMP),
    ];
    for (name, off) in header {
        let f = account["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap();
        assert_eq!(
            f["offset"].as_u64(),
            Some(off as u64),
            "header field {name}"
        );
    }
    let slot = [
        ("program_id", P_PROGRAM_ID),
        ("spend_limit", P_SPEND_LIMIT),
        ("per_tx_limit", P_PER_TX_LIMIT),
        ("spend_total", P_SPEND_TOTAL),
        ("call_count", P_CALL_COUNT),
        ("discriminators_len", P_DISC_LEN),
        ("discriminators", P_DISCRIMINATORS),
    ];
    for (name, off) in slot {
        let f = account["permissionSlots"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap();
        assert_eq!(f["offset"].as_u64(), Some(off as u64), "slot field {name}");
    }
}

#[test]
fn fixed_instruction_data_lengths_match() {
    // total length including the tag, as documented in the IDL
    let idl = idl();
    let len = |name: &str| {
        idl["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap()["dataLength"]
            .as_u64()
    };
    assert_eq!(len("create_mandate"), Some(9));
    assert_eq!(len("remove_permission"), Some(33));
    assert_eq!(len("verify"), Some(49));
    assert_eq!(len("revoke_mandate"), Some(1));
    assert_eq!(len("set_active"), Some(2));
    assert_eq!(len("update_permission"), Some(49));
    assert_eq!(len("add_permission"), None);
}
