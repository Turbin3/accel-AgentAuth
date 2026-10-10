//! LiteSVM harness for the mock AMM tests.
//!
//! Programs are loaded from env vars (`MOCK_AMM_SO`, and `AGENT_AUTH_SO` for the `CpiVerify`
//! tests). A missing `.so` is a HARD failure unless `AGENT_AUTH_ALLOW_SKIP=1`.
//!
//! How a test creates a pool (this is the documented recipe, see also `World::build`):
//! 1. pick a pool authority `PDA(["mock_amm_auth"], MOCK_AMM_ID)`;
//! 2. create two token accounts (165 bytes, state = 1) whose token-level owner is that PDA,
//!    one per mint, holding the reserves;
//! 3. `set_account(pool, Account { owner: MOCK_AMM_ID, data: PoolState{mode, vault_0, vault_1,
//!    aux_key}.encode() /* 104 bytes */, .. })`.
#![allow(dead_code, clippy::result_large_err)]

use agave_feature_set::replace_spl_token_with_p_token;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use mock_amm::{
    Mode, PoolState, INIT_POOL_DISC, MOCK_AMM_ID, POOL_AUTHORITY_SEED, POOL_STATE_LEN, PROXY_DISC,
    SWAP_DISC,
};
use solana_account::Account;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
use solana_message::Message;
pub use solana_pubkey::Pubkey;
pub use solana_signer::Signer;
use solana_transaction::Transaction;

pub const AGENT_AUTH: &str = "AKkih5YdT2WZxBi6LcsTQ4FUs7hb4vBZR9WyThHUc2if";
pub const RELAY: &str = "33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6";
pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const TOKEN22: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

pub fn mock_id() -> Pubkey {
    Pubkey::from(MOCK_AMM_ID)
}
pub fn pk(s: &str) -> Pubkey {
    s.parse().unwrap()
}
pub fn pool_authority() -> Pubkey {
    Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &mock_id()).0
}

/// Which Token binary the test runs against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavour {
    /// Classic spl-token (p-token feature deactivated in LiteSVM).
    Classic,
    /// p-token (the binary active on mainnet-beta and devnet since 2026).
    PToken,
    /// Token-2022 (extension-free accounts).
    Token2022,
}
pub const FLAVOURS: [Flavour; 3] = [Flavour::Classic, Flavour::PToken, Flavour::Token2022];

impl Flavour {
    pub fn program_id(self) -> Pubkey {
        match self {
            Flavour::Classic | Flavour::PToken => pk(TOKEN),
            Flavour::Token2022 => pk(TOKEN22),
        }
    }
}

/// Run `f` once per Token flavour.
pub fn each_flavour(f: impl Fn(Flavour)) {
    for fl in FLAVOURS {
        f(fl);
    }
}

/// Path of a required `.so`, or `None` if the test run opted out of missing binaries.
pub fn so_path(var: &str) -> Option<String> {
    match std::env::var(var) {
        Ok(p) if std::path::Path::new(&p).exists() => Some(p),
        other => {
            if std::env::var("AGENT_AUTH_ALLOW_SKIP").as_deref() == Ok("1") {
                eprintln!("SKIP: {var} not usable ({other:?}); AGENT_AUTH_ALLOW_SKIP=1");
                None
            } else {
                panic!(
                    "{var} must point at a built .so (got {other:?}); build with \
                     `cargo build-sbf --manifest-path programs/mock-amm/Cargo.toml` and export \
                     {var}=$CARGO_TARGET_DIR/deploy/<name>.so, or set AGENT_AUTH_ALLOW_SKIP=1"
                )
            }
        }
    }
}

pub fn new_svm(flavour: Flavour) -> LiteSVM {
    let mut fs = LiteSVM::mainnet_feature_set();
    match flavour {
        Flavour::Classic => fs.deactivate(&replace_spl_token_with_p_token::id()),
        Flavour::PToken => fs.activate(&replace_spl_token_with_p_token::id(), 0),
        Flavour::Token2022 => {}
    }
    LiteSVM::default()
        .with_feature_set(fs)
        .with_builtins()
        .with_lamports(1_000_000u64.wrapping_mul(1_000_000_000))
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
}

// ---- token account / mint byte layouts (spec section 6.5) -------------------------------

pub fn mint_account(svm: &LiteSVM, tp: &Pubkey, decimals: u8, supply: u64) -> Account {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    Account {
        lamports: svm.minimum_balance_for_rent_exemption(82),
        data: d,
        owner: *tp,
        ..Default::default()
    }
}

pub fn token_account(
    svm: &LiteSVM,
    tp: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    delegate: Option<(Pubkey, u64)>,
) -> Account {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    if let Some((dg, da)) = delegate {
        d[72..76].copy_from_slice(&[1, 0, 0, 0]);
        d[76..108].copy_from_slice(dg.as_ref());
        d[121..129].copy_from_slice(&da.to_le_bytes());
    }
    d[108] = 1;
    Account {
        lamports: svm.minimum_balance_for_rent_exemption(165),
        data: d,
        owner: *tp,
        ..Default::default()
    }
}

pub fn amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    let d = svm.get_account(key).unwrap().data;
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}
pub fn delegate_of(svm: &LiteSVM, key: &Pubkey) -> (Option<Pubkey>, u64) {
    let d = svm.get_account(key).unwrap().data;
    let tag = u32::from_le_bytes(d[72..76].try_into().unwrap());
    let da = u64::from_le_bytes(d[121..129].try_into().unwrap());
    let dg = (tag == 1).then(|| Pubkey::try_from(&d[76..108]).unwrap());
    (dg, da)
}
pub fn owner_field(svm: &LiteSVM, key: &Pubkey) -> Pubkey {
    Pubkey::try_from(&svm.get_account(key).unwrap().data[32..64]).unwrap()
}
pub fn supply(svm: &LiteSVM, mint: &Pubkey) -> u64 {
    let d = svm.get_account(mint).unwrap().data;
    u64::from_le_bytes(d[36..44].try_into().unwrap())
}

// ---- world --------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Cfg {
    pub mode: u8,
    /// `payer` is the token-level owner of `in_account` / `out_account` (instead of a delegate).
    pub payer_is_owner: bool,
    /// One mint for both sides (degenerate pool, used to show where `RedirectOutput` lands).
    pub same_mint: bool,
    pub in_balance: u64,
    pub out_balance: u64,
    /// `delegated_amount` granted to `payer` on `in_account` (ignored if `payer_is_owner`).
    pub delegated: u64,
    pub reserve_in: u64,
    pub reserve_out: u64,
    /// `in_vault` is `vault_1` instead of `vault_0`.
    pub reverse: bool,
    pub aux: Pubkey,
}

impl Default for Cfg {
    fn default() -> Self {
        Cfg {
            mode: Mode::Normal as u8,
            payer_is_owner: false,
            same_mint: false,
            in_balance: 10_000_000,
            out_balance: 0,
            delegated: 5_000_000,
            reserve_in: 1_000_000_000,
            reserve_out: 1_000_000_000,
            reverse: false,
            aux: Pubkey::new_unique(),
        }
    }
}

pub struct World {
    pub svm: LiteSVM,
    pub flavour: Flavour,
    pub tp: Pubkey,
    pub cfg: Cfg,
    /// Transaction fee payer (stands in for the agent key).
    pub fee: Keypair,
    /// The `payer` account of the swap: token-level delegate or owner of `in_account`.
    pub payer: Keypair,
    /// Token-level owner of the user accounts (== payer when `cfg.payer_is_owner`).
    pub owner: Pubkey,
    pub authority: Pubkey,
    pub pool: Keypair,
    pub config: Pubkey,
    pub observation: Pubkey,
    pub in_account: Pubkey,
    pub out_account: Pubkey,
    pub in_vault: Pubkey,
    pub out_vault: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
}

/// (lamports, data, owner) of an account, or `None` if it does not exist.
pub type AcctState = Option<(u64, Vec<u8>, Pubkey)>;
pub type Snapshot = Vec<(Pubkey, AcctState)>;

pub const SUPPLY: u64 = 1_000_000_000_000;

impl World {
    pub fn new(flavour: Flavour, cfg: Cfg) -> World {
        let mut w = World::build(flavour, cfg, true);
        w.install_programs();
        w
    }

    /// Like `new` but without creating the `pool_state` account (the test creates it).
    pub fn without_pool(flavour: Flavour, cfg: Cfg) -> World {
        let mut w = World::build(flavour, cfg, false);
        w.install_programs();
        w
    }

    fn install_programs(&mut self) {
        if let Some(p) = so_path("MOCK_AMM_SO") {
            self.svm.add_program_from_file(mock_id(), p).unwrap();
        }
    }

    fn build(flavour: Flavour, cfg: Cfg, with_pool: bool) -> World {
        let mut svm = new_svm(flavour);
        let tp = flavour.program_id();
        let fee = Keypair::new();
        let payer = Keypair::new();
        svm.airdrop(&fee.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
        let owner = if cfg.payer_is_owner {
            payer.pubkey()
        } else {
            Pubkey::new_unique()
        };
        let authority = pool_authority();
        let in_mint = Pubkey::new_unique();
        let out_mint = if cfg.same_mint {
            in_mint
        } else {
            Pubkey::new_unique()
        };
        svm.set_account(in_mint, mint_account(&svm, &tp, 6, SUPPLY))
            .unwrap();
        if !cfg.same_mint {
            svm.set_account(out_mint, mint_account(&svm, &tp, 9, SUPPLY))
                .unwrap();
        }
        let in_account = Pubkey::new_unique();
        let out_account = Pubkey::new_unique();
        let in_vault = Pubkey::new_unique();
        let out_vault = Pubkey::new_unique();
        let delegate = (!cfg.payer_is_owner).then(|| (payer.pubkey(), cfg.delegated));
        let acct = |svm: &LiteSVM, mint, o, amt, dg| token_account(svm, &tp, mint, o, amt, dg);
        let a = acct(&svm, &in_mint, &owner, cfg.in_balance, delegate);
        svm.set_account(in_account, a).unwrap();
        let a = acct(&svm, &out_mint, &owner, cfg.out_balance, None);
        svm.set_account(out_account, a).unwrap();
        let a = acct(&svm, &in_mint, &authority, cfg.reserve_in, None);
        svm.set_account(in_vault, a).unwrap();
        let a = acct(&svm, &out_mint, &authority, cfg.reserve_out, None);
        svm.set_account(out_vault, a).unwrap();

        let pool = Keypair::new();
        if with_pool {
            let (v0, v1) = if cfg.reverse {
                (out_vault, in_vault)
            } else {
                (in_vault, out_vault)
            };
            let state = PoolState {
                mode: Mode::from_u8(cfg.mode).unwrap_or(Mode::Normal),
                vault_0: v0.to_bytes(),
                vault_1: v1.to_bytes(),
                aux_key: cfg.aux.to_bytes(),
            };
            let mut data = state.encode().to_vec();
            data[0] = cfg.mode; // lets a test plant an undefined mode byte
            svm.set_account(
                pool.pubkey(),
                Account {
                    lamports: svm.minimum_balance_for_rent_exemption(POOL_STATE_LEN),
                    data,
                    owner: mock_id(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        World {
            svm,
            flavour,
            tp,
            cfg,
            fee,
            payer,
            owner,
            authority,
            pool,
            config: Pubkey::new_unique(),
            observation: Pubkey::new_unique(),
            in_account,
            out_account,
            in_vault,
            out_vault,
            in_mint,
            out_mint,
        }
    }

    /// The 13 Raydium CP-Swap accounts, flagged the way the relay passes them
    /// (`in_mint` read-only).
    pub fn swap_metas(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.payer.pubkey(), true),
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new_readonly(self.config, false),
            AccountMeta::new(self.pool.pubkey(), false),
            AccountMeta::new(self.in_account, false),
            AccountMeta::new(self.out_account, false),
            AccountMeta::new(self.in_vault, false),
            AccountMeta::new(self.out_vault, false),
            AccountMeta::new_readonly(self.tp, false),
            AccountMeta::new_readonly(self.tp, false),
            AccountMeta::new_readonly(self.in_mint, false),
            AccountMeta::new_readonly(self.out_mint, false),
            AccountMeta::new(self.observation, false),
        ]
    }

    pub fn swap_data(amount_in: u64, min_out: u64) -> Vec<u8> {
        let mut d = SWAP_DISC.to_vec();
        d.extend_from_slice(&amount_in.to_le_bytes());
        d.extend_from_slice(&min_out.to_le_bytes());
        d
    }

    pub fn swap_ix(&self, amount_in: u64, min_out: u64) -> Instruction {
        Instruction::new_with_bytes(
            mock_id(),
            &World::swap_data(amount_in, min_out),
            self.swap_metas(),
        )
    }

    /// `swap_ix` with `in_mint` marked writable (needed by `BurnIn` to succeed) and extra
    /// trailing accounts.
    pub fn swap_ix_with(
        &self,
        amount_in: u64,
        min_out: u64,
        mint_writable: bool,
        extra: Vec<AccountMeta>,
    ) -> Instruction {
        let mut ix = self.swap_ix(amount_in, min_out);
        if mint_writable {
            ix.accounts[10] = AccountMeta::new(self.in_mint, false);
        }
        ix.accounts.extend(extra);
        ix
    }

    /// The same swap, but executed through the mock's own `proxy` (stack height 2 for the swap).
    pub fn proxied(&self, inner: &Instruction) -> Instruction {
        let mut metas = vec![AccountMeta::new_readonly(inner.program_id, false)];
        metas.extend(inner.accounts.clone());
        let mut data = PROXY_DISC.to_vec();
        data.extend_from_slice(&inner.data);
        Instruction::new_with_bytes(mock_id(), &data, metas)
    }

    /// Sign with the fee payer plus every extra keypair (`payer` first) that the message
    /// actually requires.
    fn sign_and_send(
        &mut self,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let msg = Message::new(ixs, Some(&self.fee.pubkey()));
        let required = msg.account_keys[..msg.header.num_required_signatures as usize].to_vec();
        let mut signers: Vec<&Keypair> = vec![&self.fee];
        for kp in std::iter::once(&self.payer).chain(extra.iter().copied()) {
            if required.contains(&kp.pubkey()) {
                signers.push(kp);
            }
        }
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx)
    }

    /// Send, signed by the fee payer and (if the message needs it) `payer`.
    pub fn send(
        &mut self,
        ixs: &[Instruction],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.sign_and_send(ixs, &[])
    }

    /// Send, also signed by `extra` (e.g. the pool keypair for a `CreateAccount`).
    pub fn send_with(
        &mut self,
        ixs: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.sign_and_send(ixs, extra)
    }

    /// Snapshot of every account a swap may touch (None = account does not exist).
    pub fn snapshot(&self) -> Snapshot {
        [
            self.pool.pubkey(),
            self.in_account,
            self.out_account,
            self.in_vault,
            self.out_vault,
            self.in_mint,
            self.out_mint,
            self.observation,
        ]
        .into_iter()
        .map(|k| {
            (
                k,
                self.svm
                    .get_account(&k)
                    .map(|a| (a.lamports, a.data, a.owner)),
            )
        })
        .collect()
    }
}

// ---- failure inspection --------------------------------------------------------------------

/// First `Program <id> failed: <msg>` log line: which program raised the original error.
pub fn first_failure(logs: &[String]) -> Option<(String, String)> {
    logs.iter().find_map(|l| {
        let rest = l.strip_prefix("Program ")?;
        let (id, msg) = rest.split_once(" failed: ")?;
        Some((id.to_string(), msg.to_string()))
    })
}

/// Assert the transaction failed because `program` returned `Custom(code)` first.
#[track_caller]
pub fn assert_custom(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    program: &Pubkey,
    code: u32,
) {
    let f = res.expect_err("transaction should have failed");
    let (id, msg) = first_failure(&f.meta.logs)
        .unwrap_or_else(|| panic!("no failure log; err={:?}; logs={:#?}", f.err, f.meta.logs));
    let want = format!("custom program error: {code:#x}");
    assert!(
        id == program.to_string() && msg == want,
        "expected {program} to fail with {want}; got {id} / {msg}; err={:?}",
        f.err
    );
}

/// Assert the transaction failed and the error's debug text contains `needle`.
#[track_caller]
pub fn assert_err_contains(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    needle: &str,
) {
    let f = res.expect_err("transaction should have failed");
    let text = format!("{:?}", f.err);
    assert!(
        text.contains(needle),
        "expected error containing {needle}; got {text}; logs={:#?}",
        f.meta.logs
    );
}

// ---- system program helpers (create_account) ------------------------------------------------

pub fn create_account_ix(
    from: &Pubkey,
    new: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = vec![0u8; 4];
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction::new_with_bytes(
        solana_sdk_ids::system_program::ID,
        &data,
        vec![AccountMeta::new(*from, true), AccountMeta::new(*new, true)],
    )
}

pub fn init_pool_ix(
    pool: &Pubkey,
    v0: &Pubkey,
    v1: &Pubkey,
    mode: u8,
    aux: &Pubkey,
) -> Instruction {
    let mut data = INIT_POOL_DISC.to_vec();
    data.push(mode);
    data.extend_from_slice(aux.as_ref());
    Instruction::new_with_bytes(
        mock_id(),
        &data,
        vec![
            AccountMeta::new(*pool, false),
            AccountMeta::new_readonly(*v0, false),
            AccountMeta::new_readonly(*v1, false),
        ],
    )
}
