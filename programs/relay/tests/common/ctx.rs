//! The `Ctx` fixture: one owner O, agent A, attacker X, a budget mint, a source account S
//! (owned by O, delegate = authority PDA, `delegated_amount` D), allowlisted recipients, a REAL
//! mandate (created through the AgentAuth instructions), a REAL policy (created through the
//! relay `init_policy`), and optionally a mock-AMM pool for swap tests.
//!
//! ```ignore
//! dual_token!(transfer_happy_path, |ctx| {
//!     let before = ctx.snapshot();
//!     let r = ctx.send_agent(&[ctx.transfer_ix(1_000)]);
//!     r.assert_ok();
//!     assert_eq!(ctx.token(&ctx.source).amount, before.token(&ctx.source).amount - 1_000);
//! });
//! ```

use std::collections::{BTreeMap, BTreeSet};

use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

use super::aa::{self, MandateView, PermView};
use super::amm::{self, PoolState};
use super::assert::{audit_relay_cpis, tx_wire_size, Exec, OuterIx, Snapshot};
use super::ids::*;
use super::policy::{
    PolicyCfg, PolicyHeader, PolicyView, SwapPins, FLAG_PAUSED, FLAG_STRICT_TOP_LEVEL,
};
use super::relay_ix::{self, InitPolicyIx, SwapIx, TransferIx};
use super::svm::{self, Flavor, RelayBuild, SvmExt};
use super::token::{self, MintAcct, TokenAcct, TokenView};

// =====================================================================================
// Sending
// =====================================================================================

/// Build a signed legacy transaction paid by `signers[0]`.
pub fn build_tx(svm: &LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Transaction {
    let payer = signers[0].pubkey();
    Transaction::new(
        signers,
        Message::new(ixs, Some(&payer)),
        svm.latest_blockhash(),
    )
}

/// Send an already built transaction and wrap the result.
pub fn send_tx(svm: &mut LiteSVM, tx: Transaction) -> Exec {
    let tx_size = tx_wire_size(&tx);
    let keys = tx.message.account_keys.clone();
    let outer = tx
        .message
        .instructions
        .iter()
        .map(|ci| OuterIx {
            program: keys[ci.program_id_index as usize],
            accounts: ci.accounts.iter().map(|i| keys[*i as usize]).collect(),
            data: ci.data.clone(),
        })
        .collect();
    let result = svm.send_transaction(tx);
    Exec {
        result,
        keys,
        outer,
        tx_size,
    }
}

/// Expire the blockhash (so identical transactions are not rejected as already processed), then
/// build, sign and send.
pub fn send_keys(svm: &mut LiteSVM, signers: &[&Keypair], ixs: &[Instruction]) -> Exec {
    svm.expire_blockhash();
    let tx = build_tx(svm, signers, ixs);
    send_tx(svm, tx)
}

/// `ComputeBudget::SetComputeUnitLimit(units)`.
pub fn compute_unit_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_ID, &data, vec![])
}

/// System `Transfer` (`lamports`) without depending on `solana-system-interface`.
pub fn system_transfer_ix(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction::new_with_bytes(
        SYSTEM_ID,
        &data,
        vec![
            solana_instruction::AccountMeta::new(*from, true),
            solana_instruction::AccountMeta::new(*to, false),
        ],
    )
}

/// Who signs and pays for a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    Owner,
    Agent,
    Attacker,
}

// =====================================================================================
// Swap fixture
// =====================================================================================

/// Knobs for the swap side of a `Ctx`.
#[derive(Clone, Debug)]
pub struct SwapOpts {
    /// `in_account == source_account` (SW-14). Default: a separate account of the same mint.
    pub in_is_source: bool,
    pub reserve_in: u64,
    pub reserve_out: u64,
    pub in_balance: u64,
    pub in_delegated: u64,
    pub out_balance: u64,
    pub out_decimals: u8,
    pub floor_out: u64,
    pub floor_in: u64,
    pub max_deadline_slots: u32,
    /// Mock pool mode (`amm::mode::*`).
    pub mode: u8,
    /// Mock pool `aux_key`; `None` = the attacker's token account.
    pub aux: Option<Pubkey>,
    pub amm_program: Pubkey,
    /// Add the AMM permission to the mandate.
    pub add_permission: bool,
    pub amm_spend_limit: u64,
    pub amm_per_tx_limit: u64,
}

impl Default for SwapOpts {
    fn default() -> Self {
        Self {
            in_is_source: false,
            reserve_in: 1_000_000_000,
            reserve_out: 1_000_000_000,
            in_balance: 1_000_000_000,
            in_delegated: 100_000_000,
            out_balance: 0,
            out_decimals: 6,
            floor_out: 95,
            floor_in: 100,
            max_deadline_slots: 150,
            mode: amm::mode::NORMAL,
            aux: None,
            amm_program: MOCK_AMM_ID,
            add_permission: true,
            amm_spend_limit: 100_000_000,
            amm_per_tx_limit: 10_000_000,
        }
    }
}

/// The swap-side accounts of a `Ctx`.
#[derive(Clone, Debug)]
pub struct SwapFixture {
    pub in_account: Pubkey,
    pub out_account: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub amm_program: Pubkey,
    pub amm_authority: Pubkey,
    pub amm_config: Pubkey,
    pub pool_state: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub observation_state: Pubkey,
    pub in_token_program: Pubkey,
    pub out_token_program: Pubkey,
    pub floor_out: u64,
    pub floor_in: u64,
    pub max_deadline_slots: u32,
    pub out_decimals: u8,
}

impl SwapFixture {
    pub fn pins(&self) -> SwapPins {
        SwapPins {
            amm_program: self.amm_program,
            amm_authority: self.amm_authority,
            amm_config: self.amm_config,
            pool_state: self.pool_state,
            input_vault: self.input_vault,
            output_vault: self.output_vault,
            observation_state: self.observation_state,
            in_mint: self.in_mint,
            out_mint: self.out_mint,
            in_token_program: self.in_token_program,
            out_token_program: self.out_token_program,
            in_account: self.in_account,
            out_account: self.out_account,
            floor_out: self.floor_out,
            floor_in: self.floor_in,
            max_deadline_slots: self.max_deadline_slots,
        }
    }
}

// =====================================================================================
// Builder
// =====================================================================================

type CfgTweak = Box<dyn FnOnce(&mut PolicyCfg)>;

/// Configures and builds a [`Ctx`]. Every knob has a sensible default.
pub struct CtxBuilder {
    pub flavor: Flavor,
    pub decimals: u8,
    pub source_balance: u64,
    pub delegated: u64,
    pub spend_limit: u64,
    pub per_tx_limit: u64,
    pub n_recipients: usize,
    pub expiry: i64,
    pub flags: u8,
    pub swap: Option<SwapOpts>,
    pub init_policy: bool,
    pub token_permission: bool,
    pub token_discs: Vec<[u8; 8]>,
    pub approve_source: bool,
    /// Relay binary; `None` = `TestAmm` when `swap` is set, otherwise `Default`.
    pub relay_build: Option<RelayBuild>,
    tweak: Option<CfgTweak>,
}

impl CtxBuilder {
    pub fn new(flavor: Flavor) -> Self {
        Self {
            flavor,
            decimals: 6,
            source_balance: 1_000_000_000,
            delegated: 100_000_000,
            spend_limit: 100_000_000,
            per_tx_limit: 10_000_000,
            n_recipients: 2,
            expiry: DEFAULT_EXPIRY,
            flags: 0,
            swap: None,
            init_policy: true,
            token_permission: true,
            token_discs: vec![TRANSFER_CHECKED_DISC],
            approve_source: true,
            relay_build: None,
            tweak: None,
        }
    }

    pub fn decimals(mut self, d: u8) -> Self {
        self.decimals = d;
        self
    }

    pub fn source_balance(mut self, b: u64) -> Self {
        self.source_balance = b;
        self
    }

    /// `delegated_amount` D on the source.
    pub fn delegated(mut self, d: u64) -> Self {
        self.delegated = d;
        self
    }

    /// Token-slot `spend_limit` and `per_tx_limit` (0 = unlimited in the core).
    pub fn limits(mut self, spend_limit: u64, per_tx_limit: u64) -> Self {
        self.spend_limit = spend_limit;
        self.per_tx_limit = per_tx_limit;
        self
    }

    pub fn recipients(mut self, n: usize) -> Self {
        self.n_recipients = n;
        self
    }

    pub fn expiry(mut self, e: i64) -> Self {
        self.expiry = e;
        self
    }

    pub fn strict_top_level(mut self) -> Self {
        self.flags |= FLAG_STRICT_TOP_LEVEL;
        self
    }

    pub fn paused(mut self) -> Self {
        self.flags |= FLAG_PAUSED;
        self
    }

    pub fn flags(mut self, f: u8) -> Self {
        self.flags = f;
        self
    }

    /// Enable the swap section with default options.
    pub fn with_swap(mut self) -> Self {
        self.swap = Some(SwapOpts::default());
        self
    }

    /// Enable the swap section with custom options.
    pub fn swap(mut self, opts: SwapOpts) -> Self {
        self.swap = Some(opts);
        self
    }

    /// Mutate the swap options (enables swap with defaults first).
    pub fn swap_with(mut self, f: impl FnOnce(&mut SwapOpts)) -> Self {
        let mut o = self.swap.take().unwrap_or_default();
        f(&mut o);
        self.swap = Some(o);
        self
    }

    /// Do not run `init_policy` (the tests will, with their own config).
    pub fn no_policy(mut self) -> Self {
        self.init_policy = false;
        self
    }

    /// Do not add the Token/TransferChecked permission to the mandate.
    pub fn no_token_permission(mut self) -> Self {
        self.token_permission = false;
        self
    }

    /// Discriminators in the Token slot (default `[TRANSFER_CHECKED_DISC]`).
    pub fn token_discs(mut self, discs: &[[u8; 8]]) -> Self {
        self.token_discs = discs.to_vec();
        self
    }

    /// Leave the source without a delegate (no Approve was made).
    pub fn no_delegate(mut self) -> Self {
        self.approve_source = false;
        self
    }

    /// Force a relay binary (for example `RelayBuild::Default` together with a swap config to
    /// prove the production allowlist rejects the mock AMM, PL-04 / SW-04).
    pub fn relay_build(mut self, build: RelayBuild) -> Self {
        self.relay_build = Some(build);
        self
    }

    /// Mutate the policy config right before `init_policy` (one knob at a time).
    pub fn cfg(mut self, f: impl FnOnce(&mut PolicyCfg) + 'static) -> Self {
        self.tweak = Some(Box::new(f));
        self
    }

    /// Build; panics when a required `.so` is missing (unless `AGENT_AUTH_ALLOW_SKIP=1`, in
    /// which case it also panics here: use [`CtxBuilder::try_build`] to skip).
    #[track_caller]
    pub fn build(self) -> Ctx {
        self.try_build()
            .expect("a required .so is missing and AGENT_AUTH_ALLOW_SKIP=1: use try_build to skip")
    }

    /// Build; `None` only when a `.so` is missing and skipping is allowed.
    pub fn try_build(self) -> Option<Ctx> {
        Ctx::from_builder(self)
    }
}

/// A complete extra mock-AMM pool (own pool_state, vaults, config, observation) over the same
/// two mints as the pinned one. Used for look-alike / attacker-pool tests (RE-11, SW-03).
#[derive(Clone, Debug)]
pub struct PoolFixture {
    pub pool_state: Pubkey,
    pub input_vault: Pubkey,
    pub output_vault: Pubkey,
    pub amm_config: Pubkey,
    pub observation_state: Pubkey,
    pub amm_authority: Pubkey,
}

// =====================================================================================
// Principal: a second owner/agent/mandate/policy in the same SVM
// =====================================================================================

/// A complete second (owner, agent, mandate, policy, source) tuple inside the same LiteSVM, for
/// cross-mandate, aliasing and "attacker's own mandate" tests (TR-17..20, TR-24, DL-07).
pub struct Principal {
    pub owner: Keypair,
    pub agent: Keypair,
    pub mandate: Pubkey,
    pub policy: Pubkey,
    pub authority: Pubkey,
    pub source: Pubkey,
    pub cfg: PolicyCfg,
}

// =====================================================================================
// Ctx
// =====================================================================================

/// The test fixture. See the module docs.
pub struct Ctx {
    pub svm: LiteSVM,
    pub flavor: Flavor,
    pub token_program: Pubkey,
    pub owner: Keypair,
    pub agent: Keypair,
    pub attacker: Keypair,
    pub mint: Pubkey,
    pub decimals: u8,
    /// Owner's source token account S (delegate = authority, `delegated_amount` = D).
    pub source: Pubkey,
    /// Allowlisted recipient token accounts (owned by third parties).
    pub recipients: Vec<Pubkey>,
    /// Token-level owners of `recipients`.
    pub recipient_owners: Vec<Pubkey>,
    /// A token account of `mint` owned by the attacker X.
    pub attacker_token: Pubkey,
    /// A token account of `mint` owned by the agent (its "own ATA").
    pub agent_token: Pubkey,
    pub mandate: Pubkey,
    pub mandate_bump: u8,
    pub policy: Pubkey,
    pub policy_bump: u8,
    pub authority: Pubkey,
    pub authority_bump: u8,
    pub expiry: i64,
    /// Flags passed to the (last) successful `init_policy`.
    pub flags: u8,
    /// Config passed to the (last) successful `init_policy`.
    pub cfg: PolicyCfg,
    pub swap: Option<SwapFixture>,
    /// Initial values, for assertions.
    pub initial_source_balance: u64,
    pub initial_delegated: u64,
    pub spend_limit: u64,
    pub per_tx_limit: u64,
    /// Run the INV-01 relay CPI audit after every `send_*` (default on).
    pub audit: bool,
    tracked: BTreeSet<Pubkey>,
    labels: BTreeMap<Pubkey, String>,
    audited_agents: Vec<Pubkey>,
}

impl Ctx {
    /// Default fixture for `flavor`; panics when a `.so` is missing.
    #[track_caller]
    pub fn new(flavor: Flavor) -> Ctx {
        CtxBuilder::new(flavor).build()
    }

    /// Default fixture or `None` (skip) when a `.so` is missing and `AGENT_AUTH_ALLOW_SKIP=1`.
    pub fn try_new(flavor: Flavor) -> Option<Ctx> {
        CtxBuilder::new(flavor).try_build()
    }

    pub fn builder(flavor: Flavor) -> CtxBuilder {
        CtxBuilder::new(flavor)
    }

    fn from_builder(b: CtxBuilder) -> Option<Ctx> {
        let mut svm = svm::new_svm(b.flavor);
        let build = b.relay_build.unwrap_or(if b.swap.is_some() {
            RelayBuild::TestAmm
        } else {
            RelayBuild::Default
        });
        if !svm::load_core_and_relay(&mut svm, build) {
            return None;
        }
        if b.swap.is_some() && !svm::load_mock_amm(&mut svm) {
            return None;
        }
        let token_program = b.flavor.token_program();

        let owner = Keypair::new();
        let agent = Keypair::new();
        let attacker = Keypair::new();
        svm.airdrop(&owner.pubkey(), 100_000_000_000)
            .expect("airdrop owner");
        svm.airdrop(&agent.pubkey(), 10_000_000_000)
            .expect("airdrop agent");
        svm.airdrop(&attacker.pubkey(), 10_000_000_000)
            .expect("airdrop attacker");

        let (mandate, mandate_bump) = mandate_pda(&owner.pubkey(), &agent.pubkey());
        let (policy, policy_bump) = policy_pda(&mandate);
        let (authority, authority_bump) = authority_pda(&mandate);

        let mut ctx = Ctx {
            svm,
            flavor: b.flavor,
            token_program,
            owner,
            agent,
            attacker,
            mint: unique(),
            decimals: b.decimals,
            source: unique(),
            recipients: Vec::new(),
            recipient_owners: Vec::new(),
            attacker_token: unique(),
            agent_token: unique(),
            mandate,
            mandate_bump,
            policy,
            policy_bump,
            authority,
            authority_bump,
            expiry: b.expiry,
            flags: b.flags,
            cfg: PolicyCfg::transfer_only(token_program, Pubkey::default(), Pubkey::default(), &[]),
            swap: None,
            initial_source_balance: b.source_balance,
            initial_delegated: b.delegated,
            spend_limit: b.spend_limit,
            per_tx_limit: b.per_tx_limit,
            audit: true,
            tracked: BTreeSet::new(),
            labels: BTreeMap::new(),
            audited_agents: Vec::new(),
        };
        ctx.audited_agents.push(ctx.agent.pubkey());
        ctx.label(ctx.mandate, "mandate");
        ctx.label(ctx.policy, "policy");
        ctx.track(ctx.mandate);
        ctx.track(ctx.policy);

        // ---- mint, source, recipients, side accounts
        let mint_acct =
            MintAcct::new(token_program, b.decimals).supply(b.source_balance.saturating_mul(10));
        token::put_mint(&mut ctx.svm, ctx.mint, &mint_acct);
        ctx.label(ctx.mint, "mint");

        let mut source = TokenAcct::new(
            token_program,
            ctx.mint,
            ctx.owner.pubkey(),
            b.source_balance,
        );
        if b.approve_source {
            source = source.delegate(ctx.authority, b.delegated);
        }
        ctx.place_token(ctx.source, source, "source");

        for i in 0..b.n_recipients {
            let o = unique();
            let r = unique();
            ctx.place_token(
                r,
                TokenAcct::new(token_program, ctx.mint, o, 0),
                &format!("recipient{i}"),
            );
            ctx.recipients.push(r);
            ctx.recipient_owners.push(o);
        }
        let atk = ctx.attacker.pubkey();
        ctx.place_token(
            ctx.attacker_token,
            TokenAcct::new(token_program, ctx.mint, atk, 0),
            "attacker_token",
        );
        let agt = ctx.agent.pubkey();
        ctx.place_token(
            ctx.agent_token,
            TokenAcct::new(token_program, ctx.mint, agt, 0),
            "agent_token",
        );

        // ---- swap fixture
        if let Some(opts) = &b.swap {
            ctx.build_swap_fixture(opts);
        }

        // ---- real mandate
        let mut ixs = vec![aa::create_mandate_ix(
            &ctx.owner.pubkey(),
            &ctx.agent.pubkey(),
            b.expiry,
        )];
        if b.token_permission {
            ixs.push(aa::add_permission_ix(
                &ctx.owner.pubkey(),
                &ctx.agent.pubkey(),
                &token_program,
                b.spend_limit,
                b.per_tx_limit,
                &b.token_discs,
            ));
        }
        if let Some(opts) = &b.swap {
            if opts.add_permission {
                ixs.push(aa::add_permission_ix(
                    &ctx.owner.pubkey(),
                    &ctx.agent.pubkey(),
                    &opts.amm_program,
                    opts.amm_spend_limit,
                    opts.amm_per_tx_limit,
                    &[SWAP_DISC],
                ));
            }
        }
        ctx.send_owner(&ixs).assert_ok();

        // ---- config + real policy
        let mut cfg =
            PolicyCfg::transfer_only(token_program, ctx.mint, ctx.source, &ctx.recipients);
        if let Some(s) = &ctx.swap {
            cfg = cfg.with_swap(&s.pins());
        }
        if let Some(t) = b.tweak {
            t(&mut cfg);
        }
        ctx.cfg = cfg;
        if b.init_policy {
            let cfg = ctx.cfg.clone();
            ctx.send_owner(&[ctx.init_policy_ix(&cfg, b.flags)])
                .assert_ok();
        }
        Some(ctx)
    }

    fn build_swap_fixture(&mut self, o: &SwapOpts) {
        let tp = self.token_program;
        let owner = self.owner.pubkey();
        let pool_auth = amm::pool_authority();
        let out_mint = unique();
        token::put_mint(
            &mut self.svm,
            out_mint,
            &MintAcct::new(tp, o.out_decimals).supply(u64::MAX / 4),
        );
        self.label(out_mint, "out_mint");

        let in_account = if o.in_is_source {
            self.source
        } else {
            let k = unique();
            let acct = TokenAcct::new(tp, self.mint, owner, o.in_balance)
                .delegate(self.authority, o.in_delegated);
            self.place_token(k, acct, "in_account");
            k
        };
        let out_account = unique();
        self.place_token(
            out_account,
            TokenAcct::new(tp, out_mint, owner, o.out_balance),
            "out_account",
        );

        let input_vault = unique();
        let output_vault = unique();
        self.place_token(
            input_vault,
            TokenAcct::new(tp, self.mint, pool_auth, o.reserve_in),
            "input_vault",
        );
        self.place_token(
            output_vault,
            TokenAcct::new(tp, out_mint, pool_auth, o.reserve_out),
            "output_vault",
        );

        let amm_config = unique();
        let observation_state = unique();
        for (k, name) in [
            (amm_config, "amm_config"),
            (observation_state, "observation_state"),
        ] {
            let lamports = self.svm.rent(0).max(1_000_000);
            self.svm.put(
                k,
                solana_account::Account {
                    lamports,
                    data: vec![],
                    owner: SYSTEM_ID,
                    executable: false,
                    rent_epoch: 0,
                },
            );
            self.label(k, name);
        }

        let pool_state = unique();
        let aux = o.aux.unwrap_or(self.attacker_token);
        let ps = PoolState::normal(input_vault, output_vault)
            .mode(o.mode)
            .aux(aux);
        let lamports = self.svm.rent(amm::POOL_STATE_LEN);
        self.svm.put(pool_state, ps.account(lamports));
        self.label(pool_state, "pool_state");
        self.track(pool_state);

        self.swap = Some(SwapFixture {
            in_account,
            out_account,
            in_mint: self.mint,
            out_mint,
            amm_program: o.amm_program,
            amm_authority: pool_auth,
            amm_config,
            pool_state,
            input_vault,
            output_vault,
            observation_state,
            in_token_program: tp,
            out_token_program: tp,
            floor_out: o.floor_out,
            floor_in: o.floor_in,
            max_deadline_slots: o.max_deadline_slots,
            out_decimals: o.out_decimals,
        });
    }

    // ------------------------------------------------------------ bookkeeping

    /// Give `key` a name used in failure messages.
    pub fn label(&mut self, key: Pubkey, name: &str) {
        self.labels.insert(key, name.to_string());
    }

    /// Include `key` in [`Ctx::snapshot`].
    pub fn track(&mut self, key: Pubkey) {
        self.tracked.insert(key);
    }

    /// Place a token account, label and track it.
    pub fn place_token(&mut self, key: Pubkey, acct: TokenAcct, label: &str) {
        token::put_token(&mut self.svm, key, &acct);
        self.label(key, label);
        self.track(key);
    }

    /// Create a fresh token account of the budget mint owned by `owner`.
    pub fn new_token_account(&mut self, owner: Pubkey, amount: u64, label: &str) -> Pubkey {
        let k = unique();
        let acct = TokenAcct::new(self.token_program, self.mint, owner, amount);
        self.place_token(k, acct, label);
        k
    }

    /// Snapshot of every tracked account (token accounts, vaults, mandate, policy, pool).
    pub fn snapshot(&self) -> Snapshot {
        let mut s = Snapshot::default();
        for k in &self.tracked {
            s.accounts.insert(*k, self.svm.get_account(k));
        }
        s.labels = self.labels.clone();
        s
    }

    // ------------------------------------------------------------ reading state

    pub fn token(&self, key: &Pubkey) -> TokenView {
        TokenView::parse(&self.svm.data(key))
    }

    pub fn balance(&self, key: &Pubkey) -> u64 {
        self.token(key).amount
    }

    pub fn mandate_view(&self) -> MandateView {
        MandateView::parse(&self.svm.data(&self.mandate))
    }

    /// The permission slot for `program` (panics when absent).
    pub fn perm(&self, program: &Pubkey) -> PermView {
        self.mandate_view()
            .perm(program)
            .unwrap_or_else(|| panic!("no permission slot for {}", program_name_short(program)))
            .clone()
    }

    /// The Token slot.
    pub fn token_perm(&self) -> PermView {
        self.perm(&self.token_program)
    }

    pub fn policy_bytes(&self) -> Vec<u8> {
        self.svm.data(&self.policy)
    }

    pub fn policy_view(&self) -> PolicyView {
        PolicyView::decode(&self.policy_bytes())
    }

    /// The identity header `init_policy` is expected to have written.
    pub fn expected_header(&self, flags: u8) -> PolicyHeader {
        PolicyHeader {
            policy_bump: self.policy_bump,
            authority_bump: self.authority_bump,
            flags,
            mandate: self.mandate,
            owner: self.owner.pubkey(),
            agent: self.agent.pubkey(),
            authority: self.authority,
            mandate_expiry: self.expiry,
        }
    }

    pub fn swap_fixture(&self) -> &SwapFixture {
        self.swap.as_ref().expect("this Ctx was built without swap")
    }

    /// Expected NORMAL-mode output for `amount_in` against the CURRENT vault balances.
    pub fn expected_amount_out(&self, amount_in: u64) -> u64 {
        let s = self.swap_fixture();
        amm::amount_out(
            self.balance(&s.input_vault),
            self.balance(&s.output_vault),
            amount_in,
        )
        .expect("amount_out")
    }

    // ------------------------------------------------------------ clock

    pub fn slot(&self) -> u64 {
        self.svm.slot()
    }

    /// Move the clock to `slot` (unix time unchanged).
    pub fn warp_to_slot(&mut self, slot: u64) {
        let ts = {
            let c = self
                .svm
                .get_account(&solana_sdk_ids::sysvar::clock::ID)
                .expect("clock");
            i64::from_le_bytes(c.data[32..40].try_into().expect("8 bytes"))
        };
        self.svm.set_clock(slot, ts);
    }

    /// Set the unix timestamp (slot unchanged).
    pub fn set_unix_time(&mut self, ts: i64) {
        let slot = self.svm.slot();
        self.svm.set_clock(slot, ts);
    }

    // ------------------------------------------------------------ sending

    fn keypair(&self, who: Who) -> Keypair {
        match who {
            Who::Owner => self.owner.insecure_clone(),
            Who::Agent => self.agent.insecure_clone(),
            Who::Attacker => self.attacker.insecure_clone(),
        }
    }

    /// Send with `signers[0]` as fee payer; the INV-01 audit runs afterwards.
    #[track_caller]
    pub fn send_as(&mut self, signers: &[Who], ixs: &[Instruction]) -> Exec {
        let kps: Vec<Keypair> = signers.iter().map(|w| self.keypair(*w)).collect();
        let refs: Vec<&Keypair> = kps.iter().collect();
        self.send_keys(&refs, ixs)
    }

    /// Send with arbitrary keypairs (`signers[0]` pays); the INV-01 audit runs afterwards.
    #[track_caller]
    pub fn send_keys(&mut self, signers: &[&Keypair], ixs: &[Instruction]) -> Exec {
        let exec = send_keys(&mut self.svm, signers, ixs);
        self.audit_exec(&exec);
        exec
    }

    /// Send a prebuilt transaction (replay tests); the INV-01 audit runs afterwards.
    #[track_caller]
    pub fn send_prebuilt(&mut self, tx: Transaction) -> Exec {
        let exec = send_tx(&mut self.svm, tx);
        self.audit_exec(&exec);
        exec
    }

    /// Build and sign a transaction at the current blockhash WITHOUT expiring it first.
    pub fn build_tx_as(&self, signers: &[Who], ixs: &[Instruction]) -> Transaction {
        let kps: Vec<Keypair> = signers.iter().map(|w| self.keypair(*w)).collect();
        let refs: Vec<&Keypair> = kps.iter().collect();
        build_tx(&self.svm, &refs, ixs)
    }

    /// Agent signs and pays.
    #[track_caller]
    pub fn send_agent(&mut self, ixs: &[Instruction]) -> Exec {
        self.send_as(&[Who::Agent], ixs)
    }

    /// Owner signs and pays.
    #[track_caller]
    pub fn send_owner(&mut self, ixs: &[Instruction]) -> Exec {
        self.send_as(&[Who::Owner], ixs)
    }

    /// Attacker signs and pays.
    #[track_caller]
    pub fn send_attacker(&mut self, ixs: &[Instruction]) -> Exec {
        self.send_as(&[Who::Attacker], ixs)
    }

    #[track_caller]
    fn audit_exec(&self, exec: &Exec) {
        if !self.audit {
            return;
        }
        for agent in &self.audited_agents {
            let bad = audit_relay_cpis(exec, agent);
            assert!(
                bad.is_empty(),
                "INV-01 violated (disable with ctx.audit = false for tests that expect it):\n  {}\n{}",
                bad.join("\n  "),
                exec.pretty_logs()
            );
        }
    }

    // ------------------------------------------------------------ relay instruction builders

    /// `init_policy` for this Ctx's owner/mandate/policy with an explicit config.
    pub fn init_policy_ix(&self, cfg: &PolicyCfg, flags: u8) -> Instruction {
        InitPolicyIx::new(self.owner.pubkey(), self.mandate, self.policy).ix(&cfg.init_data(flags))
    }

    /// Struct-style handle on the `init_policy` accounts.
    pub fn init_policy_accounts(&self) -> InitPolicyIx {
        InitPolicyIx::new(self.owner.pubkey(), self.mandate, self.policy)
    }

    pub fn set_paused_ix(&self, paused: u8) -> Instruction {
        relay_ix::set_paused_ix(&self.owner.pubkey(), &self.policy, paused)
    }

    pub fn close_policy_ix(&self) -> Instruction {
        relay_ix::close_policy_ix(&self.owner.pubkey(), &self.policy)
    }

    /// Struct-style `transfer` accounts: destination = `recipients[0]`.
    pub fn transfer_accounts(&self) -> TransferIx {
        TransferIx {
            program: RELAY_ID,
            agent: self.agent.pubkey(),
            mandate: self.mandate,
            owner: self.owner.pubkey(),
            policy: self.policy,
            authority: self.authority,
            source: self.source,
            destination: self.recipients[0],
            mint: self.mint,
            token_program: self.token_program,
            agentauth_program: AGENT_AUTH_ID,
        }
    }

    /// `transfer(amount)` to `recipients[0]`.
    pub fn transfer_ix(&self, amount: u64) -> Instruction {
        self.transfer_accounts().ix(amount)
    }

    /// `transfer(amount)` to an arbitrary destination.
    pub fn transfer_ix_to(&self, destination: &Pubkey, amount: u64) -> Instruction {
        let mut t = self.transfer_accounts();
        t.destination = *destination;
        t.ix(amount)
    }

    /// `transfer` accounts of another principal (its own agent, mandate, policy, source).
    pub fn transfer_accounts_of(&self, p: &Principal) -> TransferIx {
        TransferIx {
            program: RELAY_ID,
            agent: p.agent.pubkey(),
            mandate: p.mandate,
            owner: p.owner.pubkey(),
            policy: p.policy,
            authority: p.authority,
            source: p.source,
            destination: self.recipients[0],
            mint: self.mint,
            token_program: self.token_program,
            agentauth_program: AGENT_AUTH_ID,
        }
    }

    /// Struct-style `swap` accounts (panics without a swap fixture).
    pub fn swap_accounts(&self) -> SwapIx {
        let s = self.swap_fixture();
        SwapIx {
            program: RELAY_ID,
            agent: self.agent.pubkey(),
            mandate: self.mandate,
            owner: self.owner.pubkey(),
            policy: self.policy,
            authority: self.authority,
            in_account: s.in_account,
            out_account: s.out_account,
            amm_program: s.amm_program,
            amm_authority: s.amm_authority,
            amm_config: s.amm_config,
            pool_state: s.pool_state,
            input_vault: s.input_vault,
            output_vault: s.output_vault,
            in_token_program: s.in_token_program,
            out_token_program: s.out_token_program,
            in_mint: s.in_mint,
            out_mint: s.out_mint,
            observation_state: s.observation_state,
            agentauth_program: AGENT_AUTH_ID,
        }
    }

    /// `swap(amount_in, min_out, deadline_slot)`.
    pub fn swap_ix(&self, amount_in: u64, min_out: u64, deadline_slot: u64) -> Instruction {
        self.swap_accounts().ix(amount_in, min_out, deadline_slot)
    }

    /// A deadline `offset` slots after the current slot.
    pub fn deadline(&self, offset: u64) -> u64 {
        self.slot() + offset
    }

    /// `swap(amount_in)` with `min_out = 0` and a deadline 100 slots out.
    pub fn swap_ix_default(&self, amount_in: u64) -> Instruction {
        self.swap_ix(amount_in, 0, self.deadline(100))
    }

    // ------------------------------------------------------------ core / SPL instruction builders

    pub fn create_mandate_ix(&self, expiry: i64) -> Instruction {
        aa::create_mandate_ix(&self.owner.pubkey(), &self.agent.pubkey(), expiry)
    }

    pub fn add_permission_ix(
        &self,
        program: &Pubkey,
        spend: u64,
        per_tx: u64,
        discs: &[[u8; 8]],
    ) -> Instruction {
        aa::add_permission_ix(
            &self.owner.pubkey(),
            &self.agent.pubkey(),
            program,
            spend,
            per_tx,
            discs,
        )
    }

    pub fn remove_permission_ix(&self, program: &Pubkey) -> Instruction {
        aa::remove_permission_ix(&self.owner.pubkey(), &self.agent.pubkey(), program)
    }

    pub fn revoke_mandate_ix(&self) -> Instruction {
        aa::revoke_mandate_ix(&self.owner.pubkey(), &self.agent.pubkey())
    }

    pub fn set_active_ix(&self, active: bool) -> Instruction {
        aa::set_active_ix(&self.owner.pubkey(), &self.agent.pubkey(), active)
    }

    pub fn update_permission_ix(&self, program: &Pubkey, spend: u64, per_tx: u64) -> Instruction {
        aa::update_permission_ix(
            &self.owner.pubkey(),
            &self.agent.pubkey(),
            program,
            spend,
            per_tx,
        )
    }

    /// Owner-signed `Approve(source, delegate, amount)`.
    pub fn approve_ix(&self, source: &Pubkey, delegate: &Pubkey, amount: u64) -> Instruction {
        token::spl_approve(
            &self.token_program,
            source,
            delegate,
            &self.owner.pubkey(),
            amount,
        )
    }

    /// Owner-signed `Revoke(account)`.
    pub fn revoke_delegate_ix(&self, account: &Pubkey) -> Instruction {
        token::spl_revoke(&self.token_program, account, &self.owner.pubkey())
    }

    /// The one-transaction unwind of RELAY-SPEC 12.3:
    /// `[Revoke(source), (Revoke(in_account) if distinct), revoke_mandate, close_policy]`.
    pub fn unwind_ixs(&self) -> Vec<Instruction> {
        let mut v = vec![self.revoke_delegate_ix(&self.source)];
        if let Some(s) = &self.swap {
            if s.in_account != self.source {
                v.push(self.revoke_delegate_ix(&s.in_account));
            }
        }
        v.push(self.revoke_mandate_ix());
        v.push(self.close_policy_ix());
        v
    }

    /// Raw SPL `TransferChecked` signed by `authority` from `source` to `destination`.
    pub fn raw_transfer_checked_ix(
        &self,
        authority: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> Instruction {
        token::spl_transfer_checked(
            &self.token_program,
            &self.source,
            &self.mint,
            destination,
            authority,
            amount,
            self.decimals,
        )
    }

    // ------------------------------------------------------------ account / pool editing

    /// Read-modify-write any account (negative tests: flip bytes, change owner, resize ...).
    pub fn edit_account(&mut self, key: &Pubkey, f: impl FnOnce(&mut solana_account::Account)) {
        let mut a = self
            .svm
            .get_account(key)
            .unwrap_or_else(|| panic!("edit_account: {key} does not exist"));
        f(&mut a);
        self.svm.put(*key, a);
    }

    /// Set the mandate's `active` byte directly ("seeded" inactive mandate, CORE-06).
    pub fn set_mandate_active_raw(&mut self, active: bool) {
        let m = self.mandate;
        self.edit_account(&m, |a| a.data[agent_auth::OFF_ACTIVE] = active as u8);
    }

    /// Set the mandate's expiry directly (expired mandate, CORE-06 / CORE-15).
    pub fn set_mandate_expiry_raw(&mut self, expiry: i64) {
        let m = self.mandate;
        self.edit_account(&m, |a| {
            a.data[agent_auth::OFF_EXPIRY..agent_auth::OFF_EXPIRY + 8]
                .copy_from_slice(&expiry.to_le_bytes());
        });
    }

    /// Rewrite the pinned pool's `pool_state` (mode, aux key, ...).
    pub fn set_pool(&mut self, f: impl FnOnce(&mut PoolState)) {
        let key = self.swap_fixture().pool_state;
        let mut ps = PoolState::decode(&self.svm.data(&key));
        f(&mut ps);
        self.edit_account(&key, |a| a.data = ps.encode().to_vec());
    }

    /// Set the pinned pool's behaviour (`amm_mode::*`).
    pub fn set_pool_mode(&mut self, mode: u8) {
        self.set_pool(|p| p.mode = mode);
    }

    /// Replace the balance of a token account, keeping every other byte.
    pub fn set_token_amount(&mut self, key: &Pubkey, amount: u64) {
        self.edit_account(key, |a| {
            a.data[token::OFF_AMOUNT..token::OFF_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
        });
    }

    /// A second, independent pool over the same mints (the pinned pool is untouched).
    pub fn new_pool(&mut self, mode: u8, reserve_in: u64, reserve_out: u64) -> PoolFixture {
        let s = self.swap_fixture().clone();
        let tp = self.token_program;
        let pool_auth = amm::pool_authority();
        let (input_vault, output_vault, pool_state) = (unique(), unique(), unique());
        self.place_token(
            input_vault,
            TokenAcct::new(tp, s.in_mint, pool_auth, reserve_in),
            "alt_input_vault",
        );
        self.place_token(
            output_vault,
            TokenAcct::new(tp, s.out_mint, pool_auth, reserve_out),
            "alt_output_vault",
        );
        let (amm_config, observation_state) = (unique(), unique());
        let lamports = self.svm.rent(amm::POOL_STATE_LEN);
        let ps = PoolState::normal(input_vault, output_vault)
            .mode(mode)
            .aux(self.attacker_token);
        self.svm.put(pool_state, ps.account(lamports));
        self.label(pool_state, "alt_pool_state");
        self.track(pool_state);
        PoolFixture {
            pool_state,
            input_vault,
            output_vault,
            amm_config,
            observation_state,
            amm_authority: pool_auth,
        }
    }

    /// `swap` accounts with every pool-side pin replaced by `p` (RE-11: a consistent look-alike
    /// pool while the policy pins the original).
    pub fn swap_accounts_with_pool(&self, p: &PoolFixture) -> SwapIx {
        let mut s = self.swap_accounts();
        s.amm_authority = p.amm_authority;
        s.amm_config = p.amm_config;
        s.pool_state = p.pool_state;
        s.input_vault = p.input_vault;
        s.output_vault = p.output_vault;
        s.observation_state = p.observation_state;
        s
    }

    // ------------------------------------------------------------ extra programs

    /// Install the always-Ok stub at `id` (TR-13, TR-14).
    pub fn install_always_ok(&mut self, id: Pubkey) {
        svm::install_always_ok(&mut self.svm, id);
    }

    /// Replace the Token program with the test-only `evil-token` stub (needs `EVIL_TOKEN_SO`).
    /// Returns `false` when the binary is missing and skipping is allowed.
    pub fn install_evil_token(&mut self) -> bool {
        svm::install_evil_token(&mut self.svm)
    }

    /// Load `gated_example.so` (needs `GATED_EXAMPLE_SO`).
    pub fn install_gated_example(&mut self) -> bool {
        svm::load_gated_example(&mut self.svm)
    }

    // ------------------------------------------------------------ extra principals

    /// Create a second, complete principal in the same SVM through the REAL instructions:
    /// new agent, mandate with a Token/TransferChecked permission, a fresh source account
    /// delegated to the new authority (unless `source_override`), and a policy that allowlists
    /// this Ctx's recipients. `owner = None` uses a brand-new owner; pass the Ctx owner's clone
    /// to model "same owner, second agent".
    #[track_caller]
    pub fn add_principal(
        &mut self,
        owner: Option<Keypair>,
        source_override: Option<Pubkey>,
    ) -> Principal {
        let owner = owner.unwrap_or_else(Keypair::new);
        let agent = Keypair::new();
        self.svm
            .airdrop(&owner.pubkey(), 10_000_000_000)
            .expect("airdrop");
        self.svm
            .airdrop(&agent.pubkey(), 10_000_000_000)
            .expect("airdrop");
        let (mandate, _) = mandate_pda(&owner.pubkey(), &agent.pubkey());
        let (policy, _) = policy_pda(&mandate);
        let (authority, _) = authority_pda(&mandate);
        let source = match source_override {
            Some(s) => s,
            None => {
                let k = unique();
                let acct = TokenAcct::new(
                    self.token_program,
                    self.mint,
                    owner.pubkey(),
                    self.initial_source_balance,
                )
                .delegate(authority, self.initial_delegated);
                self.place_token(k, acct, "principal_source");
                k
            }
        };
        let cfg = PolicyCfg::transfer_only(self.token_program, self.mint, source, &self.recipients);
        let setup = [
            aa::create_mandate_ix(&owner.pubkey(), &agent.pubkey(), self.expiry),
            aa::add_permission_ix(
                &owner.pubkey(),
                &agent.pubkey(),
                &self.token_program,
                self.spend_limit,
                self.per_tx_limit,
                &[TRANSFER_CHECKED_DISC],
            ),
            InitPolicyIx::new(owner.pubkey(), mandate, policy).ix(&cfg.init_data(0)),
        ];
        // create + add_permission first (init_policy reads the live mandate)
        send_keys(&mut self.svm, &[&owner], &setup[..2]).assert_ok();
        send_keys(&mut self.svm, &[&owner], &setup[2..]).assert_ok();
        self.track(mandate);
        self.track(policy);
        self.audited_agents.push(agent.pubkey());
        Principal {
            owner,
            agent,
            mandate,
            policy,
            authority,
            source,
            cfg,
        }
    }
}

fn program_name_short(id: &Pubkey) -> String {
    super::assert::program_name(id)
}
