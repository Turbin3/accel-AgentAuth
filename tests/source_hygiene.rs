//! Guards the code-quality promises about `src/` (production code only, i.e.
//! everything before a `#[cfg(test)]` marker): no `unsafe` outside the
//! pinocchio entrypoint module, no panicking shortcuts, no discarded results,
//! no stale TODOs.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn production_code(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap();
    let cut = text.find("#[cfg(test)]").unwrap_or(text.len());
    text[..cut]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn src_has_no_unsafe_or_panicking_shortcuts() {
    let mut files = Vec::new();
    rust_files(Path::new("src"), &mut files);
    assert!(files.len() >= 10, "expected to scan the whole src tree");

    let banned = [
        ("unsafe ", "unsafe block or fn"),
        (".unwrap()", "unwrap"),
        (".expect(", "expect"),
        ("panic!", "panic!"),
        ("unreachable!", "unreachable!"),
        ("let _ =", "discarded result"),
        ("from_raw_parts", "raw slice construction"),
        ("read_unaligned", "raw pointer read"),
    ];
    for file in &files {
        let code = production_code(file);
        for (needle, what) in banned {
            assert!(
                !code.contains(needle),
                "{}: contains {what} ({needle:?})",
                file.display()
            );
        }
    }
}

#[test]
fn src_has_no_stale_todo_markers() {
    let mut files = Vec::new();
    rust_files(Path::new("src"), &mut files);
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains("TODO"), "{}: stale TODO", file.display());
    }
}

#[test]
fn unsafe_is_denied_at_the_crate_root_except_for_the_entrypoint() {
    let lib = fs::read_to_string("src/lib.rs").unwrap();
    assert!(lib.contains("#![deny(unsafe_code)]"));
    assert_eq!(lib.matches("allow(unsafe_code)").count(), 1);
}

#[test]
fn the_hot_path_derives_no_addresses_and_makes_no_cpi() {
    // verify is called from other programs' hot paths: no PDA derivation (a
    // find_program_address costs >1,500 CU) and no CPI. revoke may only use the
    // search for legacy version-0 mandates.
    let verify = production_code(Path::new("src/instructions/verify.rs"));
    for needle in [
        "find_program_address",
        "create_program_address",
        "invoke",
        "Seed",
    ] {
        assert!(
            !verify.contains(needle),
            "verify.rs must not contain {needle}"
        );
    }
    let revoke = production_code(Path::new("src/instructions/revoke_mandate.rs"));
    assert!(
        revoke.contains("create_program_address"),
        "revoke uses the stored bump"
    );
    assert_eq!(
        revoke.matches("find_program_address(").count(),
        1,
        "one fallback search, for version 0"
    );
}

#[test]
fn every_error_code_is_documented_in_the_contract_table() {
    // src/error.rs carries the table integrators rely on; each variant must
    // appear in it with its number.
    let text = fs::read_to_string("src/error.rs").unwrap();
    for (name, code) in [
        ("InvalidDiscriminator", 1),
        ("NotOwner", 2),
        ("AlreadyInitialized", 3),
        ("NotActive", 4),
        ("Expired", 5),
        ("ProgramNotAllowed", 6),
        ("DiscriminatorNotAllowed", 7),
        ("PerTxExceeded", 8),
        ("SpendLimitExceeded", 9),
        ("PermissionsFull", 10),
        ("TooManyDiscriminators", 11),
        ("PermissionNotFound", 12),
        ("ArithmeticOverflow", 13),
        ("AccountOwnerMismatch", 14),
        ("InvalidInstructionData", 15),
        ("InvalidAccountType", 16),
        ("UnknownAgent", 17),
        ("InvalidSigner", 18),
        ("InvalidAgent", 19),
        ("InvalidExpiry", 20),
        ("DuplicatePermission", 21),
        ("EmptyDiscriminators", 22),
    ] {
        let row = text
            .lines()
            .find(|l| l.starts_with("//!") && l.contains(&format!("`{name}`")))
            .unwrap_or_else(|| panic!("{name} is missing from the table in src/error.rs"));
        assert!(
            row.contains(&format!("| {code:>3}"))
                || row.contains(&format!("|  {code}"))
                || row.contains(&format!("| {code} ")),
            "{name}: table row does not say {code}: {row}"
        );
        assert!(
            text.contains(&format!("{name} = {code},")),
            "{name} is not numbered {code}"
        );
    }
}
