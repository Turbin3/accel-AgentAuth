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
