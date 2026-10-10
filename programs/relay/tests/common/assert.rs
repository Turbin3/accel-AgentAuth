//! Execution results and assertions.
//!
//! * [`Exec`] wraps a LiteSVM `TransactionResult` together with the message account keys, so the
//!   inner-instruction list can be resolved to program ids.
//! * [`assert_err`] asserts `Custom(code)` AND the program that raised it (codes overlap between
//!   AgentAuth, Token and the relay), found from the transaction logs.
//! * [`Snapshot`] / [`assert_nothing_moved`] implement the "nothing moved" rule of TEST-MATRIX
//!   harness rule 3.
//! * CU, serialized transaction size, `Program data:` events and the INV-01 CPI audit.

use std::collections::BTreeMap;

use litesvm::types::{TransactionMetadata, TransactionResult};
use solana_account::Account;
use solana_pubkey::Pubkey;
use solana_transaction::{InstructionError, Transaction, TransactionError};

use super::aa::MandateView;
use super::ids::*;
use super::token::TokenView;

// =====================================================================================
// Program names
// =====================================================================================

/// Human name of a well-known program id (falls back to base58).
pub fn program_name(id: &Pubkey) -> String {
    match *id {
        AGENT_AUTH_ID => "agent_auth".into(),
        RELAY_ID => "relay".into(),
        MOCK_AMM_ID => "mock_amm".into(),
        GATED_EXAMPLE_ID => "gated_example".into(),
        TOKEN_ID => "token".into(),
        TOKEN22_ID => "token2022".into(),
        SYSTEM_ID => "system".into(),
        ATA_PROGRAM_ID => "ata".into(),
        COMPUTE_BUDGET_ID => "compute_budget".into(),
        other => other.to_string(),
    }
}

/// Name of a code for a known program (best effort, for failure messages).
pub fn error_name(program: &Pubkey, code: u32) -> String {
    match *program {
        RELAY_ID if (100..120).contains(&code) => relay_err::NAMES[(code - 100) as usize].into(),
        AGENT_AUTH_ID if code <= 22 => format!("agent_auth#{code}"),
        _ => format!("#{code}"),
    }
}

// =====================================================================================
// Log parsing
// =====================================================================================

/// One `Program <id> failed: ...` line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub program: Pubkey,
    /// Text after `failed: `.
    pub detail: String,
    /// `Some(n)` for `custom program error: 0xN`.
    pub custom: Option<u32>,
}

/// All `Program <id> failed: ...` lines, in log order. When a CPI fails the CALLEE logs first and
/// each caller then repeats the propagated error, so the first entry with the code in question
/// is the program that raised it.
pub fn parse_failures(logs: &[String]) -> Vec<Failure> {
    logs.iter()
        .filter_map(|line| {
            let rest = line.strip_prefix("Program ")?;
            let (id, detail) = rest.split_once(" failed: ")?;
            let program: Pubkey = id.parse().ok()?;
            let custom = detail
                .strip_prefix("custom program error: 0x")
                .and_then(|h| u32::from_str_radix(h.trim(), 16).ok());
            Some(Failure {
                program,
                detail: detail.to_string(),
                custom,
            })
        })
        .collect()
}

/// The program that raised `Custom(code)`: the first failure line carrying that code.
pub fn failing_program(logs: &[String], code: u32) -> Option<Pubkey> {
    parse_failures(logs)
        .into_iter()
        .find(|f| f.custom == Some(code))
        .map(|f| f.program)
}

fn tx_error_of(result: &TransactionResult) -> Option<&TransactionError> {
    result.as_ref().err().map(|f| &f.err)
}

fn meta_of(result: &TransactionResult) -> &TransactionMetadata {
    match result {
        Ok(m) => m,
        Err(f) => &f.meta,
    }
}

/// `Custom(code)` of an instruction error, if that is what the transaction failed with.
pub fn custom_code(result: &TransactionResult) -> Option<u32> {
    match tx_error_of(result)? {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

/// Assert the transaction failed with `Custom(code)` raised by `program`.
///
/// Panics with the expected and actual (program, code, name) and the pretty logs.
#[track_caller]
pub fn assert_err(result: &TransactionResult, program: &Pubkey, code: u32) {
    let meta = meta_of(result);
    match result {
        Ok(_) => panic!(
            "expected {} {} ({code}) but the transaction SUCCEEDED\n{}",
            program_name(program),
            error_name(program, code),
            meta.pretty_logs()
        ),
        Err(f) => {
            let got_code = custom_code(result);
            if got_code != Some(code) {
                panic!(
                    "expected {} {} ({code}) but the transaction failed with {:?}\n{}",
                    program_name(program),
                    error_name(program, code),
                    f.err,
                    meta.pretty_logs()
                );
            }
            let got_program = failing_program(&meta.logs, code);
            if got_program.as_ref() != Some(program) {
                panic!(
                    "Custom({code}) was raised by {} but expected {} ({})\n{}",
                    got_program
                        .map(|p| program_name(&p))
                        .unwrap_or_else(|| "<no failure line with that code>".into()),
                    program_name(program),
                    error_name(program, code),
                    meta.pretty_logs()
                );
            }
        }
    }
}

/// Assert a relay error code (100..119).
#[track_caller]
pub fn assert_relay_err(result: &TransactionResult, code: u32) {
    assert_err(result, &RELAY_ID, code);
}

/// Assert an AgentAuth error code.
#[track_caller]
pub fn assert_aa_err(result: &TransactionResult, code: u32) {
    assert_err(result, &AGENT_AUTH_ID, code);
}

/// Assert a Token error code raised by the program id `token_program`.
#[track_caller]
pub fn assert_token_err(result: &TransactionResult, token_program: &Pubkey, code: u32) {
    assert_err(result, token_program, code);
}

/// Assert the transaction failed with a non-custom instruction error (for example
/// `NotEnoughAccountKeys`, `InvalidAccountData`, `ComputationalBudgetExceeded`).
#[track_caller]
pub fn assert_instruction_error(result: &TransactionResult, expected: InstructionError) {
    match result {
        Ok(m) => panic!(
            "expected InstructionError::{expected:?} but the transaction SUCCEEDED\n{}",
            m.pretty_logs()
        ),
        Err(f) => match &f.err {
            TransactionError::InstructionError(_, got) if *got == expected => {}
            other => panic!(
                "expected InstructionError::{expected:?} but got {other:?}\n{}",
                f.meta.pretty_logs()
            ),
        },
    }
}

/// Assert the transaction failed with `NotEnoughAccountKeys`, which is what the relay returns
/// for a wrong account count (exact-count rule, FE-09). The variant is marked deprecated in the
/// runtime crate in favour of `MissingAccount`, but `ProgramError::NotEnoughAccountKeys` still
/// surfaces as the old variant (verified against the relay in LiteSVM 0.12).
#[allow(deprecated)]
#[track_caller]
pub fn assert_not_enough_accounts(result: &TransactionResult) {
    assert_instruction_error(result, InstructionError::NotEnoughAccountKeys);
}

/// Assert the transaction failed at all (use when the exact error is runtime-defined).
#[track_caller]
pub fn assert_failed(result: &TransactionResult) {
    if let Ok(m) = result {
        panic!(
            "expected the transaction to FAIL but it succeeded\n{}",
            m.pretty_logs()
        );
    }
}

/// Assert the transaction succeeded; prints the logs otherwise.
#[track_caller]
pub fn assert_ok(result: &TransactionResult) {
    if let Err(f) = result {
        panic!(
            "expected success but the transaction failed with {:?}\n{}",
            f.err,
            f.meta.pretty_logs()
        );
    }
}

/// Compute units consumed (available for both success and failure).
pub fn cu(result: &TransactionResult) -> u64 {
    meta_of(result).compute_units_consumed
}

// =====================================================================================
// Serialized transaction size
// =====================================================================================

fn shortvec_len(n: usize) -> usize {
    match n {
        0..=0x7f => 1,
        0x80..=0x3fff => 2,
        _ => 3,
    }
}

/// Length of the legacy wire encoding of `tx` (signatures + message), the number the 1232-byte
/// packet limit applies to.
pub fn tx_wire_size(tx: &Transaction) -> usize {
    shortvec_len(tx.signatures.len()) + 64 * tx.signatures.len() + tx.message.serialize().len()
}

// =====================================================================================
// Snapshots: "nothing moved"
// =====================================================================================

/// Full state (lamports, owner, data) of a set of accounts.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub accounts: BTreeMap<Pubkey, Option<Account>>,
    pub labels: BTreeMap<Pubkey, String>,
}

impl Snapshot {
    pub fn get(&self, key: &Pubkey) -> Option<&Account> {
        self.accounts.get(key).and_then(|a| a.as_ref())
    }

    /// Decoded token account from the snapshot.
    pub fn token(&self, key: &Pubkey) -> TokenView {
        TokenView::parse(
            &self
                .get(key)
                .unwrap_or_else(|| panic!("{key} not in snapshot"))
                .data,
        )
    }

    /// Decoded mandate from the snapshot.
    pub fn mandate(&self, key: &Pubkey) -> MandateView {
        MandateView::parse(
            &self
                .get(key)
                .unwrap_or_else(|| panic!("{key} not in snapshot"))
                .data,
        )
    }

    fn label(&self, key: &Pubkey) -> String {
        self.labels
            .get(key)
            .map(|l| format!("{l} ({key})"))
            .unwrap_or_else(|| key.to_string())
    }
}

/// Describe the difference between two states of one account.
fn describe_diff(before: &Option<Account>, after: &Option<Account>) -> String {
    match (before, after) {
        (None, None) => "no change".into(),
        (None, Some(_)) => "account was CREATED".into(),
        (Some(_), None) => "account was CLOSED / removed".into(),
        (Some(b), Some(a)) => {
            let mut parts = Vec::new();
            if b.lamports != a.lamports {
                parts.push(format!("lamports {} -> {}", b.lamports, a.lamports));
            }
            if b.owner != a.owner {
                parts.push(format!("owner {} -> {}", b.owner, a.owner));
            }
            if b.data.len() != a.data.len() {
                parts.push(format!("data len {} -> {}", b.data.len(), a.data.len()));
            } else if let Some(i) = (0..b.data.len()).find(|&i| b.data[i] != a.data[i]) {
                parts.push(format!(
                    "first differing byte at offset {i}: 0x{:02x} -> 0x{:02x}",
                    b.data[i], a.data[i]
                ));
            }
            if b.data.len() >= 165 && a.data.len() >= 165 && b.data.len() == a.data.len() {
                let (tb, ta) = (TokenView::parse(&b.data), TokenView::parse(&a.data));
                if tb != ta {
                    parts.push(format!("token {tb:?} -> {ta:?}"));
                }
            }
            if b.data.len() == super::aa::MANDATE_LEN && a.data.len() == b.data.len() {
                let (mb, ma) = (MandateView::parse(&b.data), MandateView::parse(&a.data));
                if mb != ma {
                    parts.push(format!("mandate {mb:?} -> {ma:?}"));
                }
            }
            parts.join("; ")
        }
    }
}

/// Assert that every tracked account is byte-identical (lamports, owner, data) between the two
/// snapshots: all token balances, `delegated_amount`, delegates, and every mandate permission
/// counter. Use after a failed transaction.
#[track_caller]
pub fn assert_nothing_moved(before: &Snapshot, after: &Snapshot) {
    let mut problems = Vec::new();
    for (key, b) in &before.accounts {
        match after.accounts.get(key) {
            None => problems.push(format!(
                "{}: missing from the after-snapshot",
                before.label(key)
            )),
            Some(a) if a != b => {
                problems.push(format!("{}: {}", before.label(key), describe_diff(b, a)))
            }
            Some(_) => {}
        }
    }
    for key in after.accounts.keys() {
        if !before.accounts.contains_key(key) {
            problems.push(format!(
                "{}: missing from the before-snapshot",
                after.label(key)
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "state changed although nothing should have moved:\n  {}",
        problems.join("\n  ")
    );
}

// =====================================================================================
// Events
// =====================================================================================

/// Base64 (standard alphabet, padded) decoder; returns `None` on malformed input.
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.trim().bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Relay events (relay-idl.json `events`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelayEvent {
    TransferExecuted {
        mandate: Pubkey,
        destination: Pubkey,
        mint: Pubkey,
        amount: u64,
    },
    SwapExecuted {
        mandate: Pubkey,
        pool_state: Pubkey,
        amount_in_requested: u64,
        in_delta: u64,
        out_delta: u64,
    },
    PolicyInitialized {
        mandate: Pubkey,
        policy: Pubkey,
        flags: u8,
    },
    PolicyClosed {
        mandate: Pubkey,
        policy: Pubkey,
    },
    PausedChanged {
        mandate: Pubkey,
        paused: u8,
    },
}

fn key_at(d: &[u8], o: usize) -> Pubkey {
    Pubkey::try_from(&d[o..o + 32]).expect("32 bytes")
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().expect("8 bytes"))
}

/// Decode one event payload; `None` when the tag/size is not a relay event.
pub fn decode_event(d: &[u8]) -> Option<RelayEvent> {
    Some(match (d.first()?, d.len()) {
        (1, 105) => RelayEvent::TransferExecuted {
            mandate: key_at(d, 1),
            destination: key_at(d, 33),
            mint: key_at(d, 65),
            amount: u64_at(d, 97),
        },
        (2, 89) => RelayEvent::SwapExecuted {
            mandate: key_at(d, 1),
            pool_state: key_at(d, 33),
            amount_in_requested: u64_at(d, 65),
            in_delta: u64_at(d, 73),
            out_delta: u64_at(d, 81),
        },
        (3, 66) => RelayEvent::PolicyInitialized {
            mandate: key_at(d, 1),
            policy: key_at(d, 33),
            flags: d[65],
        },
        (4, 65) => RelayEvent::PolicyClosed {
            mandate: key_at(d, 1),
            policy: key_at(d, 33),
        },
        (5, 34) => RelayEvent::PausedChanged {
            mandate: key_at(d, 1),
            paused: d[33],
        },
        _ => return None,
    })
}

/// Every `Program data:` payload in the logs, decoded from base64 (events and anything else).
pub fn program_data(logs: &[String]) -> Vec<Vec<u8>> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|rest| rest.split_whitespace().next().and_then(base64_decode))
        .collect()
}

/// Relay events found in the logs.
pub fn relay_events(logs: &[String]) -> Vec<RelayEvent> {
    program_data(logs)
        .iter()
        .filter_map(|d| decode_event(d))
        .collect()
}

// =====================================================================================
// Exec: a sent transaction
// =====================================================================================

/// A top-level instruction of the sent transaction.
#[derive(Clone, Debug)]
pub struct OuterIx {
    pub program: Pubkey,
    pub accounts: Vec<Pubkey>,
    pub data: Vec<u8>,
}

/// One CPI observed in the inner-instruction list.
#[derive(Clone, Debug)]
pub struct InnerCall {
    /// Index of the top-level instruction this CPI belongs to.
    pub top_index: usize,
    /// 2 = made by a top-level program, 3 = made by that program's callee, ...
    pub stack_height: u8,
    pub program: Pubkey,
    pub data: Vec<u8>,
    pub accounts: Vec<Pubkey>,
    /// Program that made this CPI.
    pub parent: Pubkey,
}

/// A transaction after `send`: the LiteSVM result plus what is needed to interpret it.
#[derive(Debug)]
pub struct Exec {
    pub result: TransactionResult,
    pub keys: Vec<Pubkey>,
    pub outer: Vec<OuterIx>,
    /// Serialized (wire) length of the transaction.
    pub tx_size: usize,
}

impl Exec {
    pub fn meta(&self) -> &TransactionMetadata {
        meta_of(&self.result)
    }

    pub fn logs(&self) -> &[String] {
        &self.meta().logs
    }

    pub fn is_ok(&self) -> bool {
        self.result.is_ok()
    }

    pub fn cu(&self) -> u64 {
        cu(&self.result)
    }

    /// Print-friendly logs.
    pub fn pretty_logs(&self) -> String {
        self.meta().pretty_logs()
    }

    #[track_caller]
    pub fn assert_ok(&self) -> &Self {
        assert_ok(&self.result);
        self
    }

    #[track_caller]
    pub fn assert_err(&self, program: &Pubkey, code: u32) -> &Self {
        assert_err(&self.result, program, code);
        self
    }

    #[track_caller]
    pub fn assert_relay_err(&self, code: u32) -> &Self {
        assert_relay_err(&self.result, code);
        self
    }

    #[track_caller]
    pub fn assert_aa_err(&self, code: u32) -> &Self {
        assert_aa_err(&self.result, code);
        self
    }

    #[track_caller]
    pub fn assert_token_err(&self, token_program: &Pubkey, code: u32) -> &Self {
        assert_token_err(&self.result, token_program, code);
        self
    }

    #[track_caller]
    pub fn assert_instruction_error(&self, expected: InstructionError) -> &Self {
        assert_instruction_error(&self.result, expected);
        self
    }

    #[track_caller]
    pub fn assert_not_enough_accounts(&self) -> &Self {
        assert_not_enough_accounts(&self.result);
        self
    }

    #[track_caller]
    pub fn assert_failed(&self) -> &Self {
        assert_failed(&self.result);
        self
    }

    /// Relay events emitted by this transaction.
    pub fn events(&self) -> Vec<RelayEvent> {
        relay_events(self.logs())
    }

    /// Every CPI of the transaction with resolved program ids and parents.
    pub fn inner_calls(&self) -> Vec<InnerCall> {
        let mut calls = Vec::new();
        for (top_index, group) in self.meta().inner_instructions.iter().enumerate() {
            let Some(top) = self.outer.get(top_index) else {
                continue;
            };
            // Stack of (height, program) of the currently open frames.
            let mut stack: Vec<(u8, Pubkey)> = vec![(1, top.program)];
            for inner in group {
                while stack.last().is_some_and(|(h, _)| *h >= inner.stack_height) {
                    stack.pop();
                }
                let parent = stack.last().map(|(_, p)| *p).unwrap_or(top.program);
                let program = self.keys[inner.instruction.program_id_index as usize];
                calls.push(InnerCall {
                    top_index,
                    stack_height: inner.stack_height,
                    program,
                    data: inner.instruction.data.clone(),
                    accounts: inner
                        .instruction
                        .accounts
                        .iter()
                        .map(|i| self.keys[*i as usize])
                        .collect(),
                    parent,
                });
                stack.push((inner.stack_height, program));
            }
        }
        calls
    }

    /// CPIs made directly by the relay program.
    pub fn relay_cpis(&self) -> Vec<InnerCall> {
        self.inner_calls()
            .into_iter()
            .filter(|c| c.parent == RELAY_ID)
            .collect()
    }

    /// Maximum instruction stack height reached.
    pub fn max_stack_height(&self) -> u8 {
        self.inner_calls()
            .iter()
            .map(|c| c.stack_height)
            .max()
            .unwrap_or(1)
    }
}

// =====================================================================================
// INV-01: CPI audit
// =====================================================================================

/// What the relay is allowed to CPI into (TEST-MATRIX INV-01, RELAY-SPEC invariant I1/I6):
/// AgentAuth `verify` (tag 3, 49 bytes), the token program's `TransferChecked` (tag 12, 10
/// bytes), an AMM `swap_base_input` (SWAP_DISC, 24 bytes), and System create/assign/transfer/
/// allocate. The agent key may appear only in `verify`. Returns the violations.
pub fn audit_relay_cpis(exec: &Exec, agent: &Pubkey) -> Vec<String> {
    let mut bad = Vec::new();
    for c in exec.relay_cpis() {
        let who = program_name(&c.program);
        let ok = match c.program {
            AGENT_AUTH_ID => c.data.len() == 49 && c.data[0] == 3,
            TOKEN_ID | TOKEN22_ID => c.data.len() == 10 && c.data[0] == 12,
            SYSTEM_ID => {
                c.data.len() >= 4
                    && matches!(
                        u32::from_le_bytes([c.data[0], c.data[1], c.data[2], c.data[3]]),
                        0 | 1 | 2 | 8
                    )
            }
            _ => c.data.len() == 24 && c.data[..8] == SWAP_DISC,
        };
        if !ok {
            bad.push(format!(
                "relay made a disallowed CPI into {who}: data[..{}] = {:02x?}",
                c.data.len().min(12),
                &c.data[..c.data.len().min(12)]
            ));
        }
        let is_verify = c.program == AGENT_AUTH_ID && c.data.first() == Some(&3);
        if !is_verify && c.accounts.contains(agent) {
            bad.push(format!(
                "the agent key was passed to a non-verify CPI into {who}"
            ));
        }
    }
    bad
}
