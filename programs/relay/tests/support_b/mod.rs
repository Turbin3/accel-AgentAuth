//! Helpers shared by `sw.rs`, `re.rs`, `t22.rs` and `fe.rs` (test engineer B). Not a test target:
//! cargo only builds `tests/*.rs` and `tests/<name>/main.rs`.

#![allow(dead_code)]

use solana_pubkey::Pubkey;

/// One program invocation reconstructed from the transaction logs.
#[derive(Clone, Debug)]
pub struct Invocation {
    pub program: Pubkey,
    /// 1 = top-level instruction.
    pub depth: usize,
    /// Compute units consumed (includes CPIs made by the program).
    pub consumed: u64,
    /// Sum of `consumed` of the direct children.
    pub children: u64,
}

impl Invocation {
    /// CUs spent by the program itself, excluding every program it invoked.
    pub fn own(&self) -> u64 {
        self.consumed.saturating_sub(self.children)
    }
}

/// Parse `Program <id> invoke [n]` / `Program <id> consumed X of Y compute units` log lines.
/// Invocations are returned in completion order (callees before callers).
pub fn invocations(logs: &[String]) -> Vec<Invocation> {
    let mut stack: Vec<(Pubkey, usize, u64)> = Vec::new(); // (program, depth, children so far)
    let mut done = Vec::new();
    for line in logs {
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        let mut it = rest.split_whitespace();
        let (Some(id), Some(word)) = (it.next(), it.next()) else {
            continue;
        };
        let Ok(program) = id.parse::<Pubkey>() else {
            continue;
        };
        match word {
            "invoke" => {
                let depth = it
                    .next()
                    .and_then(|d| d.trim_matches(|c| c == '[' || c == ']').parse().ok())
                    .unwrap_or(stack.len() + 1);
                stack.push((program, depth, 0));
            }
            "consumed" => {
                let consumed: u64 = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                if let Some((p, depth, children)) = stack.last().copied() {
                    if p == program {
                        done.push(Invocation {
                            program,
                            depth,
                            consumed,
                            children,
                        });
                        stack.pop();
                        if let Some(parent) = stack.last_mut() {
                            parent.2 += consumed;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    done
}

/// The invocation of `program` at the shallowest depth (the relay or the proxy entry), if any.
pub fn first_invocation(logs: &[String], program: &Pubkey) -> Option<Invocation> {
    invocations(logs)
        .into_iter()
        .filter(|i| &i.program == program)
        .min_by_key(|i| i.depth)
}

/// Print one measurement line that a human (or script) can grep for: `MEASURE | label | value`.
pub fn measure(label: &str, value: impl std::fmt::Display) {
    eprintln!("MEASURE | {label} | {value}");
}
