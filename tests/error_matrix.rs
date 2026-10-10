//! Table-driven error contract: every instruction x every failure condition,
//! asserting the exact code documented in `src/error.rs` and that a failed
//! instruction changes nothing observable (mandate, owner, agent, stranger and
//! the decoy accounts are byte- and lamport-identical afterwards).
//!
//! Each row names one condition. A row fails independently; the test reports
//! every failing row at once. Conditions the table cannot express as a single
//! instruction (state machines, sequences) live in `regression_lifecycle.rs`
//! and `model_properties.rs`.

mod common;
use common::integration::*;

use agent_auth::state::Mandate;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum K {
    Create,
    Add,
    Remove,
    Update,
    SetActive,
    Revoke,
    Verify,
}

/// Where the mandate PDA starts out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    /// Nothing at the address.
    Fresh,
    /// Active, expires far in the future, three permissions.
    Active,
    Paused,
    /// Active flag set but `now >= expiry`.
    Expired,
    /// Paused and expired at once.
    PausedExpired,
    /// Sixteen permissions in use.
    Full,
    /// Same bytes as `Active`, owned by an unrelated program.
    Foreign,
    /// Program-owned, 2135 bytes.
    Short,
    /// Program-owned, 2137 bytes.
    Long,
    /// Program-owned, right size, discriminator byte 2.
    BadDisc,
    /// Program-owned, right size, discriminator byte 0 (a husk).
    ZeroDisc,
    /// Program-owned, right size, discriminator 1 but permissions_len = 17.
    CorruptLen,
    /// System-owned with 10 bytes of data.
    SysData,
    /// `Active`, but the owner holds u64::MAX lamports.
    RichOwner,
}

#[derive(Debug)]
enum W {
    Code(E),
    Builtin(&'static str),
    Ok,
}

struct Fx {
    e: Env,
    stranger: Keypair,
    payer: Keypair,
    target: Pubkey,
    other: Pubkey,
    third: Pubkey,
    /// Program-owned, valid-looking, but not the canonical PDA of (owner, agent).
    fake: Pubkey,
}

const OTHER_DISC: [u8; 8] = [9; 8];

impl Fx {
    fn build(st: St) -> Option<Fx> {
        let mut e = env()?;
        let stranger = funded(&mut e.svm, 1_000_000_000);
        let payer = funded(&mut e.svm, 10_000_000_000);
        let (target, other, third) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );

        if st != St::Fresh {
            let expiry = if matches!(st, St::Expired | St::PausedExpired) {
                NOW + 100
            } else {
                FUTURE
            };
            assert_ok(e.create(expiry));
            assert_ok(e.add(&target, 1_000, 400, &[DISC]));
            assert_ok(e.add(&other, 0, 0, &[OTHER_DISC]));
            assert_ok(e.add(&third, 100, 0, &[DISC]));
            if st == St::Full {
                for _ in 0..13 {
                    assert_ok(e.add(&Pubkey::new_unique(), 0, 0, &[DISC]));
                }
            }
            match st {
                St::Paused => {
                    assert_ok(e.set_active(0));
                }
                St::PausedExpired => {
                    assert_ok(e.set_active(0));
                    set_time(&mut e.svm, NOW + 100);
                }
                St::Expired => set_time(&mut e.svm, NOW + 100),
                St::RichOwner => {
                    let mut acc = e.svm.get_account(&e.owner_key()).unwrap();
                    acc.lamports = u64::MAX;
                    e.put_account(e.owner_key(), acc);
                }
                _ => {}
            }
            let mandate = e.mandate();
            let mut acc = e.svm.get_account(&mandate).unwrap();
            let replace = match st {
                St::Foreign => {
                    acc.owner = Pubkey::new_unique();
                    true
                }
                St::Short => {
                    acc.data.truncate(ACCOUNT_SIZE - 1);
                    true
                }
                St::Long => {
                    acc.data.push(0);
                    true
                }
                St::BadDisc => {
                    acc.data[OFF_DISC] = 2;
                    true
                }
                St::ZeroDisc => {
                    acc.data[OFF_DISC] = 0;
                    true
                }
                St::CorruptLen => {
                    acc.data[OFF_PERM_LEN] = 17;
                    true
                }
                St::SysData => {
                    acc.owner = solana_sdk_ids::system_program::ID;
                    acc.data = vec![7; 10];
                    true
                }
                _ => false,
            };
            if replace {
                e.put_account(mandate, acc);
            }
        }

        // A decoy that looks like this pair's mandate but lives at another address.
        let fake = Pubkey::new_unique();
        let mut data = vec![0u8; ACCOUNT_SIZE];
        Mandate::initialize(
            &mut data,
            &e.owner_key().to_bytes(),
            &e.agent_key().to_bytes(),
            FUTURE,
            e.bump(),
        )
        .unwrap();
        e.put_account(
            fake,
            Account {
                lamports: 5_000_000,
                data,
                owner: program_id(),
                ..Default::default()
            },
        );
        Some(Fx {
            e,
            stranger,
            payer,
            target,
            other,
            third,
            fake,
        })
    }

    fn keys(&self) -> Vec<Pubkey> {
        vec![
            self.e.mandate(),
            self.e.owner_key(),
            self.e.agent_key(),
            self.stranger.pubkey(),
            self.fake,
        ]
    }

    fn owner(&self) -> Pubkey {
        self.e.owner_key()
    }
    fn agent(&self) -> Pubkey {
        self.e.agent_key()
    }
    fn mandate(&self) -> Pubkey {
        self.e.mandate()
    }
    fn stranger_key(&self) -> Pubkey {
        self.stranger.pubkey()
    }
}

/// The valid instruction of each kind; rows mutate it.
fn base(kind: K, fx: &Fx) -> Instruction {
    let (o, a, m) = (fx.owner(), fx.agent(), fx.mandate());
    match kind {
        K::Create => create_ix(&o, &a, FUTURE),
        K::Add => add_ix(&o, &m, &Pubkey::new_unique(), 5, 5, &[DISC]),
        K::Remove => remove_ix(&o, &m, &fx.target),
        K::Update => update_ix(&o, &m, &fx.target, 2_000, 300),
        K::SetActive => set_active_ix(&o, &m, 0),
        K::Revoke => revoke_ix(&o, &m),
        K::Verify => verify_ix(&m, &o, &a, &fx.target, &DISC, 100),
    }
}

type Mutate = Box<dyn Fn(&mut Instruction, &Fx)>;

struct Case {
    name: String,
    kind: K,
    st: St,
    mutate: Mutate,
    want: W,
}

fn case(
    name: impl Into<String>,
    kind: K,
    st: St,
    want: W,
    mutate: impl Fn(&mut Instruction, &Fx) + 'static,
) -> Case {
    Case {
        name: name.into(),
        kind,
        st,
        mutate: Box::new(mutate),
        want,
    }
}

fn run_case(c: &Case) -> Result<(), String> {
    let Some(mut fx) = Fx::build(c.st) else {
        return Ok(());
    };
    let mut ix = base(c.kind, &fx);
    (c.mutate)(&mut ix, &fx);

    let keys = fx.keys();
    let before = Snapshot::take(&fx.e.svm, &keys);
    let (owner, agent, stranger, payer) = (
        fx.e.owner.insecure_clone(),
        fx.e.agent.insecure_clone(),
        fx.stranger.insecure_clone(),
        fx.payer.insecure_clone(),
    );
    let result = send_signed_as_marked(&mut fx.e.svm, &payer, &[&owner, &agent, &stranger], &[ix]);
    let after = Snapshot::take(&fx.e.svm, &keys);

    let label = format!("{:?}/{:?}: {}", c.kind, c.st, c.name);
    match (&c.want, result) {
        (W::Ok, Ok(_)) => Ok(()),
        (W::Ok, Err(e)) => Err(format!("{label}: expected success, got {:?}", e.err)),
        (W::Code(want), Err(e)) => {
            let text = format!("{:?}", e.err);
            if custom_code(&text) != Some(*want as u32) {
                return Err(format!(
                    "{label}: expected {want:?} ({}), got {text}",
                    *want as u32
                ));
            }
            if before != after {
                return Err(format!("{label}: failed instruction changed state"));
            }
            Ok(())
        }
        (W::Code(want), Ok(_)) => Err(format!("{label}: expected {want:?}, but it succeeded")),
        (W::Builtin(needle), Err(e)) => {
            let text = format!("{:?}", e.err);
            if !text.contains(needle) || text.contains("Custom(") {
                return Err(format!("{label}: expected builtin {needle}, got {text}"));
            }
            if before != after {
                return Err(format!("{label}: failed instruction changed state"));
            }
            Ok(())
        }
        (W::Builtin(needle), Ok(_)) => Err(format!("{label}: expected {needle}, but it succeeded")),
    }
}

// --- the table ---------------------------------------------------------------------

const OWNER_FAMILY: [K; 5] = [K::Add, K::Remove, K::Update, K::SetActive, K::Revoke];

/// Conditions shared by every owner-signed instruction (`add`, `remove`,
/// `update`, `set_active`, `revoke`): the same condition must give the same code.
fn owner_family_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    for k in OWNER_FAMILY {
        // signature and identity
        rows.push(case(
            "owner does not sign",
            k,
            St::Active,
            W::Code(E::InvalidSigner),
            |ix, _| ix.accounts[0].is_signer = false,
        ));
        rows.push(case(
            "a stranger signs as the owner",
            k,
            St::Active,
            W::Code(E::NotOwner),
            |ix, fx| ix.accounts[0].pubkey = fx.stranger_key(),
        ));
        rows.push(case(
            "the agent signs as the owner",
            k,
            St::Active,
            W::Code(E::NotOwner),
            |ix, fx| {
                ix.accounts[0].pubkey = fx.agent();
                // the agent keypair signs; payer is separate
            },
        ));
        // account list shape
        rows.push(case(
            "no accounts",
            k,
            St::Active,
            W::Code(E::InvalidInstructionData),
            |ix, _| ix.accounts.clear(),
        ));
        rows.push(case(
            "only the owner account",
            k,
            St::Active,
            W::Code(E::InvalidInstructionData),
            |ix, _| ix.accounts.truncate(1),
        ));
        rows.push(case(
            "extra trailing accounts are ignored",
            k,
            St::Active,
            W::Ok,
            |ix, fx| {
                ix.accounts
                    .push(AccountMeta::new_readonly(fx.stranger_key(), false))
            },
        ));
        // mandate account properties
        rows.push(case(
            "mandate is read-only",
            k,
            St::Active,
            W::Builtin("InvalidAccountData"),
            |ix, _| ix.accounts[1].is_writable = false,
        ));
        for (st, why, want) in [
            (
                St::Foreign,
                "mandate owned by another program",
                E::AccountOwnerMismatch,
            ),
            (
                St::Fresh,
                "mandate account does not exist",
                E::AccountOwnerMismatch,
            ),
            (
                St::SysData,
                "mandate is a system account with data",
                E::AccountOwnerMismatch,
            ),
            (St::Short, "mandate is 2135 bytes", E::InvalidAccountType),
            (St::Long, "mandate is 2137 bytes", E::InvalidAccountType),
            (
                St::BadDisc,
                "mandate discriminator is 2",
                E::InvalidAccountType,
            ),
            (
                St::ZeroDisc,
                "mandate discriminator is 0",
                E::InvalidAccountType,
            ),
            (
                St::CorruptLen,
                "permissions_len is 17",
                E::InvalidAccountType,
            ),
        ] {
            rows.push(case(why, k, st, W::Code(want), |_, _| {}));
        }
        // instruction data length +-1
        rows.push(case(
            "one trailing byte",
            k,
            St::Active,
            W::Code(E::InvalidInstructionData),
            |ix, _| ix.data.push(0),
        ));
        rows.push(case(
            "one byte short",
            k,
            St::Active,
            W::Code(E::InvalidInstructionData),
            |ix, _| {
                ix.data.pop();
            },
        ));
        // aliasing
        rows.push(case(
            "mandate passed in the owner slot",
            k,
            St::Active,
            W::Code(E::InvalidSigner),
            |ix, fx| ix.accounts[0] = AccountMeta::new(fx.mandate(), false),
        ));
        rows.push(case(
            "owner and mandate slots swapped",
            k,
            St::Active,
            W::Code(E::InvalidSigner),
            |ix, _| ix.accounts.swap(0, 1),
        ));
        rows.push(case(
            "owner passed as the mandate",
            k,
            St::Active,
            W::Code(E::AccountOwnerMismatch),
            |ix, fx| ix.accounts[1] = AccountMeta::new(fx.owner(), true),
        ));
        rows.push(case(
            "stranger passed in both slots",
            k,
            St::Active,
            W::Code(E::AccountOwnerMismatch),
            |ix, fx| {
                ix.accounts[0] = AccountMeta::new(fx.stranger_key(), true);
                ix.accounts[1] = AccountMeta::new(fx.stranger_key(), false);
            },
        ));
        // a decoy mandate that names the right owner but sits at another address
        // is accepted by the pure-state handlers (they never derive the address) and refused by revoke
        // order of checks (error.rs table)
        rows.push(case(
            "bad length wins over a missing signature",
            k,
            St::Active,
            W::Code(E::InvalidInstructionData),
            |ix, _| {
                ix.data.push(0);
                ix.accounts[0].is_signer = false;
            },
        ));
        rows.push(case(
            "missing signature wins over foreign owner",
            k,
            St::Foreign,
            W::Code(E::InvalidSigner),
            |ix, _| ix.accounts[0].is_signer = false,
        ));
        rows.push(case(
            "foreign owner wins over read-only",
            k,
            St::Foreign,
            W::Code(E::AccountOwnerMismatch),
            |ix, _| ix.accounts[1].is_writable = false,
        ));
        rows.push(case(
            "read-only wins over wrong size",
            k,
            St::Short,
            W::Builtin("InvalidAccountData"),
            |ix, _| ix.accounts[1].is_writable = false,
        ));
        rows.push(case(
            "wrong size wins over wrong signer",
            k,
            St::Short,
            W::Code(E::InvalidAccountType),
            |ix, fx| ix.accounts[0].pubkey = fx.stranger_key(),
        ));
        rows.push(case(
            "wrong signer wins over paused",
            k,
            St::Paused,
            W::Code(E::NotOwner),
            |ix, fx| ix.accounts[0].pubkey = fx.stranger_key(),
        ));
        // unknown extra decoys never matter
        rows.push(case(
            "expired mandate can still be managed",
            k,
            St::Expired,
            W::Ok,
            |_, _| {},
        ));
    }

    // paused: every mutator except set_active and revoke is refused
    for k in [K::Add, K::Remove, K::Update] {
        rows.push(case(
            "mandate is paused",
            k,
            St::Paused,
            W::Code(E::NotActive),
            |_, _| {},
        ));
    }
    for k in [K::SetActive, K::Revoke] {
        rows.push(case(
            "works on a paused mandate",
            k,
            St::Paused,
            W::Ok,
            |_, _| {},
        ));
    }

    // revoke derives the address
    rows.push(case(
        "mandate address is not the canonical PDA",
        K::Revoke,
        St::Active,
        W::Code(E::InvalidAccountType),
        |ix, fx| ix.accounts[1].pubkey = fx.fake,
    ));
    rows.push(case(
        "a revoked mandate cannot be revoked again",
        K::Revoke,
        St::Fresh,
        W::Code(E::AccountOwnerMismatch),
        |_, _| {},
    ));
    rows.push(case(
        "lamport credit overflow",
        K::Revoke,
        St::RichOwner,
        W::Code(E::ArithmeticOverflow),
        |_, _| {},
    ));
    rows
}

fn add_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    let with = |discs: &'static [[u8; 8]]| {
        move |ix: &mut Instruction, fx: &Fx| {
            *ix = add_ix(
                &fx.owner(),
                &fx.mandate(),
                &Pubkey::new_unique(),
                5,
                5,
                discs,
            )
        }
    };
    static EIGHT: [[u8; 8]; 8] = [
        [1; 8], [2; 8], [3; 8], [4; 8], [5; 8], [6; 8], [7; 8], [8; 8],
    ];
    static NINE: [[u8; 8]; 9] = [
        [1; 8], [2; 8], [3; 8], [4; 8], [5; 8], [6; 8], [7; 8], [8; 8], [9; 8],
    ];

    rows.push(case(
        "one discriminator",
        K::Add,
        St::Active,
        W::Ok,
        |_, _| {},
    ));
    rows.push(case(
        "eight discriminators (the maximum)",
        K::Add,
        St::Active,
        W::Ok,
        with(&EIGHT),
    ));
    rows.push(case(
        "nine discriminators",
        K::Add,
        St::Active,
        W::Code(E::TooManyDiscriminators),
        with(&NINE),
    ));
    rows.push(case(
        "zero discriminators",
        K::Add,
        St::Active,
        W::Code(E::EmptyDiscriminators),
        with(&[]),
    ));
    rows.push(case(
        "duplicate program",
        K::Add,
        St::Active,
        W::Code(E::DuplicatePermission),
        |ix, fx| *ix = add_ix(&fx.owner(), &fx.mandate(), &fx.target, 5, 5, &[DISC]),
    ));
    rows.push(case(
        "seventeenth permission",
        K::Add,
        St::Full,
        W::Code(E::PermissionsFull),
        |_, _| {},
    ));
    rows.push(case(
        "duplicate wins over full",
        K::Add,
        St::Full,
        W::Code(E::DuplicatePermission),
        |ix, fx| *ix = add_ix(&fx.owner(), &fx.mandate(), &fx.target, 5, 5, &[DISC]),
    ));
    rows.push(case(
        "too many discriminators wins over full",
        K::Add,
        St::Full,
        W::Code(E::TooManyDiscriminators),
        with(&NINE),
    ));
    rows.push(case(
        "empty list wins over duplicate",
        K::Add,
        St::Active,
        W::Code(E::EmptyDiscriminators),
        |ix, fx| *ix = add_ix(&fx.owner(), &fx.mandate(), &fx.target, 5, 5, &[]),
    ));
    rows.push(case(
        "paused wins over empty list",
        K::Add,
        St::Paused,
        W::Code(E::NotActive),
        with(&[]),
    ));
    rows.push(case(
        "max limits are accepted",
        K::Add,
        St::Active,
        W::Ok,
        |ix, fx| {
            *ix = add_ix(
                &fx.owner(),
                &fx.mandate(),
                &Pubkey::new_unique(),
                u64::MAX,
                u64::MAX,
                &[DISC],
            )
        },
    ));
    rows.push(case(
        "zero limits (unlimited) are accepted",
        K::Add,
        St::Active,
        W::Ok,
        |ix, fx| {
            *ix = add_ix(
                &fx.owner(),
                &fx.mandate(),
                &Pubkey::new_unique(),
                0,
                0,
                &[DISC],
            )
        },
    ));
    // the length byte must describe the bytes that follow
    for (name, len_byte) in [
        ("length byte 0 with one discriminator", 0u8),
        ("length byte 2 with one discriminator", 2),
        ("length byte 255", 255),
    ] {
        rows.push(case(
            name,
            K::Add,
            St::Active,
            W::Code(E::InvalidInstructionData),
            move |ix, _| ix.data[1 + 32 + 16] = len_byte,
        ));
    }
    rows.push(case(
        "length byte 9 with nine discriminators is TooMany, not malformed",
        K::Add,
        St::Active,
        W::Code(E::TooManyDiscriminators),
        with(&NINE),
    ));
    rows.push(case(
        "payload shorter than the fixed fields",
        K::Add,
        St::Active,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.data.truncate(1 + 32 + 16),
    ));
    rows
}

fn remove_update_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    for k in [K::Remove, K::Update] {
        rows.push(case(
            "unknown program",
            k,
            St::Active,
            W::Code(E::PermissionNotFound),
            |ix, _| ix.data[1..33].copy_from_slice(Pubkey::new_unique().as_ref()),
        ));
        rows.push(case(
            "the zero key is not a program with a slot",
            k,
            St::Active,
            W::Code(E::PermissionNotFound),
            |ix, _| ix.data[1..33].fill(0),
        ));
        rows.push(case(
            "unknown program on a paused mandate reports NotActive",
            k,
            St::Paused,
            W::Code(E::NotActive),
            |ix, _| ix.data[1..33].copy_from_slice(Pubkey::new_unique().as_ref()),
        ));
        rows.push(case("the last of sixteen", k, St::Full, W::Ok, |ix, fx| {
            let last = fx.e.data()[slot_base(15)..slot_base(15) + 32].to_vec();
            ix.data[1..33].copy_from_slice(&last)
        }));
    }
    rows.push(case(
        "update with max limits",
        K::Update,
        St::Active,
        W::Ok,
        |ix, fx| *ix = update_ix(&fx.owner(), &fx.mandate(), &fx.target, u64::MAX, u64::MAX),
    ));
    rows.push(case(
        "update to zero (unlimited)",
        K::Update,
        St::Active,
        W::Ok,
        |ix, fx| *ix = update_ix(&fx.owner(), &fx.mandate(), &fx.target, 0, 0),
    ));
    rows
}

fn set_active_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    for (name, payload, want) in [
        ("value 0 pauses", vec![0u8], W::Ok),
        ("value 1 resumes", vec![1], W::Ok),
        ("value 2", vec![2], W::Code(E::InvalidInstructionData)),
        ("value 255", vec![255], W::Code(E::InvalidInstructionData)),
        ("two bytes", vec![1, 0], W::Code(E::InvalidInstructionData)),
        ("no value", vec![], W::Code(E::InvalidInstructionData)),
    ] {
        let data: Vec<u8> = std::iter::once(5u8).chain(payload).collect();
        rows.push(case(name, K::SetActive, St::Active, want, move |ix, _| {
            ix.data = data.clone()
        }));
    }
    rows.push(case(
        "resume a paused mandate",
        K::SetActive,
        St::Paused,
        W::Ok,
        |ix, _| ix.data = vec![5, 1],
    ));
    rows.push(case(
        "pause an already paused mandate",
        K::SetActive,
        St::Paused,
        W::Ok,
        |ix, _| ix.data = vec![5, 0],
    ));
    rows
}

fn revoke_rows() -> Vec<Case> {
    vec![
        case(
            "revoke an active mandate",
            K::Revoke,
            St::Active,
            W::Ok,
            |_, _| {},
        ),
        case(
            "revoke without the trailing system program account",
            K::Revoke,
            St::Active,
            W::Ok,
            |ix, _| ix.accounts.truncate(2),
        ),
        case(
            "revoke an expired mandate",
            K::Revoke,
            St::PausedExpired,
            W::Ok,
            |_, _| {},
        ),
        // Contract gap, pinned as it is: revoke does not check that the owner is
        // writable, so the runtime rejects the lamport credit. Atomic and harmless,
        // but a built-in error rather than a MandateError.
        case(
            "owner account is read-only",
            K::Revoke,
            St::Active,
            W::Builtin("ReadonlyLamportChange"),
            |ix, _| ix.accounts[0].is_writable = false,
        ),
    ]
}

fn create_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    let c = |name: &str, st: St, want: W, m: fn(&mut Instruction, &Fx)| {
        case(name, K::Create, st, want, m)
    };

    rows.push(c("fresh mandate", St::Fresh, W::Ok, |_, _| {}));
    rows.push(c(
        "owner does not sign",
        St::Fresh,
        W::Code(E::InvalidSigner),
        |ix, _| ix.accounts[0].is_signer = false,
    ));
    rows.push(c(
        "owner is the agent",
        St::Fresh,
        W::Code(E::InvalidAgent),
        |ix, fx| ix.accounts[1].pubkey = fx.owner(),
    ));
    rows.push(c(
        "missing signature wins over owner == agent",
        St::Fresh,
        W::Code(E::InvalidSigner),
        |ix, fx| {
            ix.accounts[1].pubkey = fx.owner();
            ix.accounts[0].is_signer = false;
        },
    ));
    rows.push(c(
        "no accounts",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.accounts.clear(),
    ));
    rows.push(c(
        "two accounts",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.accounts.truncate(2),
    ));
    rows.push(c(
        "extra trailing accounts are ignored",
        St::Fresh,
        W::Ok,
        |ix, fx| {
            ix.accounts
                .push(AccountMeta::new_readonly(fx.stranger_key(), false))
        },
    ));
    rows.push(c(
        "one trailing byte",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.data.push(0),
    ));
    rows.push(c(
        "expiry one byte short",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, _| {
            ix.data.pop();
        },
    ));
    rows.push(c(
        "no expiry",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.data.truncate(1),
    ));
    rows.push(c(
        "wrong PDA address",
        St::Fresh,
        W::Code(E::InvalidAccountType),
        |ix, fx| ix.accounts[2].pubkey = fx.fake,
    ));
    rows.push(c(
        "the owner's own address as the mandate",
        St::Fresh,
        W::Code(E::InvalidAccountType),
        |ix, fx| ix.accounts[2] = AccountMeta::new(fx.owner(), false),
    ));
    rows.push(c(
        "bad length wins over wrong PDA",
        St::Fresh,
        W::Code(E::InvalidInstructionData),
        |ix, fx| {
            ix.accounts[2].pubkey = fx.fake;
            ix.data.push(0);
        },
    ));
    rows.push(c(
        "wrong PDA wins over a past expiry",
        St::Fresh,
        W::Code(E::InvalidAccountType),
        |ix, fx| {
            ix.accounts[2].pubkey = fx.fake;
            ix.data[1..9].copy_from_slice(&0i64.to_le_bytes());
        },
    ));
    rows.push(c(
        "past expiry wins over read-only mandate",
        St::Fresh,
        W::Code(E::InvalidExpiry),
        |ix, _| {
            ix.accounts[2].is_writable = false;
            ix.data[1..9].copy_from_slice(&0i64.to_le_bytes());
        },
    ));
    rows.push(c(
        "read-only mandate",
        St::Fresh,
        W::Builtin("InvalidAccountData"),
        |ix, _| ix.accounts[2].is_writable = false,
    ));
    // expiry boundary: the clock sits at NOW
    for (name, expiry, ok) in [
        ("expiry = now + 1 is the earliest valid", NOW + 1, true),
        ("expiry = now", NOW, false),
        ("expiry = now - 1", NOW - 1, false),
        ("expiry = 0", 0, false),
        ("expiry = -1", -1, false),
        ("expiry = i64::MIN", i64::MIN, false),
        ("expiry = i64::MAX", i64::MAX, true),
    ] {
        let want = if ok { W::Ok } else { W::Code(E::InvalidExpiry) };
        rows.push(case(name, K::Create, St::Fresh, want, move |ix, _| {
            ix.data[1..9].copy_from_slice(&expiry.to_le_bytes())
        }));
    }
    // what is already at the address
    for st in [St::Active, St::Paused, St::Expired] {
        rows.push(c(
            "mandate already initialised",
            st,
            W::Code(E::AlreadyInitialized),
            |_, _| {},
        ));
    }
    rows.push(c(
        "owned by another program",
        St::Foreign,
        W::Code(E::AccountOwnerMismatch),
        |_, _| {},
    ));
    rows.push(c(
        "program-owned, 2135 bytes",
        St::Short,
        W::Code(E::InvalidAccountType),
        |_, _| {},
    ));
    rows.push(c(
        "program-owned, 2137 bytes",
        St::Long,
        W::Code(E::InvalidAccountType),
        |_, _| {},
    ));
    rows.push(c(
        "program-owned, discriminator 2",
        St::BadDisc,
        W::Code(E::InvalidAccountType),
        |_, _| {},
    ));
    rows.push(c(
        "system-owned with data",
        St::SysData,
        W::Code(E::InvalidAccountType),
        |_, _| {},
    ));
    rows.push(c(
        "zero-discriminator husk is adopted",
        St::ZeroDisc,
        W::Ok,
        |_, _| {},
    ));
    rows
}

fn verify_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    let v = |name: &str, st: St, want: W, m: fn(&mut Instruction, &Fx)| {
        case(name, K::Verify, st, want, m)
    };
    // verify's data: [3] + target[32] + disc[8] + amount[8]
    const TARGET: std::ops::Range<usize> = 1..33;
    const DISCR: std::ops::Range<usize> = 33..41;
    const AMOUNT: std::ops::Range<usize> = 41..49;

    rows.push(v("allowed call", St::Active, W::Ok, |_, _| {}));
    rows.push(v(
        "extra trailing accounts are ignored",
        St::Active,
        W::Ok,
        |ix, fx| {
            ix.accounts
                .push(AccountMeta::new_readonly(fx.stranger_key(), false))
        },
    ));
    // data shape
    rows.push(v(
        "one trailing byte",
        St::Active,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.data.push(0),
    ));
    rows.push(v(
        "one byte short",
        St::Active,
        W::Code(E::InvalidInstructionData),
        |ix, _| {
            ix.data.pop();
        },
    ));
    rows.push(v(
        "empty payload",
        St::Active,
        W::Code(E::InvalidInstructionData),
        |ix, _| ix.data.truncate(1),
    ));
    rows.push(v(
        "bad length wins over missing accounts",
        St::Active,
        W::Code(E::InvalidInstructionData),
        |ix, _| {
            ix.data.push(0);
            ix.accounts.truncate(1);
        },
    ));
    // account list
    rows.push(v(
        "no accounts",
        St::Active,
        W::Builtin("NotEnoughAccountKeys"),
        |ix, _| ix.accounts.clear(),
    ));
    rows.push(v(
        "two accounts",
        St::Active,
        W::Builtin("NotEnoughAccountKeys"),
        |ix, _| ix.accounts.truncate(2),
    ));
    // mandate account
    rows.push(v(
        "mandate is read-only",
        St::Active,
        W::Builtin("InvalidAccountData"),
        |ix, _| ix.accounts[0].is_writable = false,
    ));
    for (st, why, want) in [
        (
            St::Foreign,
            "mandate owned by another program",
            E::AccountOwnerMismatch,
        ),
        (
            St::Fresh,
            "mandate account does not exist (revoked)",
            E::AccountOwnerMismatch,
        ),
        (
            St::SysData,
            "mandate is a system account",
            E::AccountOwnerMismatch,
        ),
        (St::Short, "mandate is 2135 bytes", E::InvalidAccountType),
        (St::Long, "mandate is 2137 bytes", E::InvalidAccountType),
        (
            St::BadDisc,
            "mandate discriminator is 2",
            E::InvalidAccountType,
        ),
        (
            St::ZeroDisc,
            "mandate discriminator is 0",
            E::InvalidAccountType,
        ),
        (
            St::CorruptLen,
            "permissions_len is 17",
            E::InvalidAccountType,
        ),
    ] {
        rows.push(v(why, st, W::Code(want), |_, _| {}));
    }
    // lifecycle gates
    rows.push(v("paused", St::Paused, W::Code(E::NotActive), |_, _| {}));
    rows.push(v("expired", St::Expired, W::Code(E::Expired), |_, _| {}));
    rows.push(v(
        "paused wins over expired",
        St::PausedExpired,
        W::Code(E::NotActive),
        |_, _| {},
    ));
    rows.push(v(
        "paused wins over an unknown program",
        St::Paused,
        W::Code(E::NotActive),
        |ix, _| ix.data[TARGET].copy_from_slice(Pubkey::new_unique().as_ref()),
    ));
    rows.push(v(
        "expired wins over a wrong owner account",
        St::Expired,
        W::Code(E::Expired),
        |ix, fx| ix.accounts[1].pubkey = fx.stranger_key(),
    ));
    // identity checks
    rows.push(v(
        "owner account is a stranger",
        St::Active,
        W::Code(E::NotOwner),
        |ix, fx| ix.accounts[1].pubkey = fx.stranger_key(),
    ));
    rows.push(v(
        "mandate passed as the owner account",
        St::Active,
        W::Code(E::NotOwner),
        |ix, fx| ix.accounts[1].pubkey = fx.mandate(),
    ));
    rows.push(v(
        "agent passed as the owner account",
        St::Active,
        W::Code(E::NotOwner),
        |ix, fx| ix.accounts[1].pubkey = fx.agent(),
    ));
    rows.push(v(
        "agent account is a signing stranger",
        St::Active,
        W::Code(E::UnknownAgent),
        |ix, fx| ix.accounts[2].pubkey = fx.stranger_key(),
    ));
    rows.push(v(
        "owner signs in the agent slot",
        St::Active,
        W::Code(E::UnknownAgent),
        |ix, fx| ix.accounts[2].pubkey = fx.owner(),
    ));
    rows.push(v(
        "mandate passed as the agent account",
        St::Active,
        W::Code(E::UnknownAgent),
        |ix, fx| ix.accounts[2] = AccountMeta::new_readonly(fx.mandate(), false),
    ));
    rows.push(v(
        "owner passed in both owner and agent slots",
        St::Active,
        W::Code(E::UnknownAgent),
        |ix, fx| ix.accounts[2] = AccountMeta::new_readonly(fx.owner(), false),
    ));
    rows.push(v(
        "agent did not sign",
        St::Active,
        W::Code(E::InvalidSigner),
        |ix, _| ix.accounts[2].is_signer = false,
    ));
    rows.push(v(
        "wrong owner wins over wrong agent",
        St::Active,
        W::Code(E::NotOwner),
        |ix, fx| {
            ix.accounts[1].pubkey = fx.stranger_key();
            ix.accounts[2].pubkey = fx.stranger_key();
        },
    ));
    rows.push(v(
        "wrong agent wins over a missing signature",
        St::Active,
        W::Code(E::UnknownAgent),
        |ix, fx| ix.accounts[2] = AccountMeta::new_readonly(fx.stranger_key(), false),
    ));
    rows.push(v(
        "missing signature wins over an unknown program",
        St::Active,
        W::Code(E::InvalidSigner),
        |ix, _| {
            ix.accounts[2].is_signer = false;
            ix.data[TARGET].copy_from_slice(Pubkey::new_unique().as_ref());
        },
    ));
    // permission checks
    rows.push(v(
        "program has no slot",
        St::Active,
        W::Code(E::ProgramNotAllowed),
        |ix, _| ix.data[TARGET].copy_from_slice(Pubkey::new_unique().as_ref()),
    ));
    rows.push(v(
        "the zero key does not match an empty slot",
        St::Active,
        W::Code(E::ProgramNotAllowed),
        |ix, _| ix.data[TARGET].fill(0),
    ));
    rows.push(v(
        "the zero key on a full mandate",
        St::Full,
        W::Code(E::ProgramNotAllowed),
        |ix, _| ix.data[TARGET].fill(0),
    ));
    rows.push(v(
        "discriminator not listed",
        St::Active,
        W::Code(E::DiscriminatorNotAllowed),
        |ix, _| ix.data[DISCR].copy_from_slice(&[1; 8]),
    ));
    rows.push(v(
        "the zero discriminator does not match unused entries",
        St::Active,
        W::Code(E::DiscriminatorNotAllowed),
        |ix, _| ix.data[DISCR].fill(0),
    ));
    rows.push(v(
        "another program's discriminator",
        St::Active,
        W::Code(E::DiscriminatorNotAllowed),
        |ix, _| ix.data[DISCR].copy_from_slice(&OTHER_DISC),
    ));
    rows.push(v(
        "unknown program wins over unknown discriminator",
        St::Active,
        W::Code(E::ProgramNotAllowed),
        |ix, _| {
            ix.data[TARGET].copy_from_slice(Pubkey::new_unique().as_ref());
            ix.data[DISCR].copy_from_slice(&[1; 8]);
        },
    ));
    rows.push(v(
        "unknown discriminator wins over per-tx",
        St::Active,
        W::Code(E::DiscriminatorNotAllowed),
        |ix, _| {
            ix.data[DISCR].copy_from_slice(&[1; 8]);
            ix.data[AMOUNT].copy_from_slice(&u64::MAX.to_le_bytes());
        },
    ));
    // limits: target has spend 1000 / per-tx 400; third has spend 100 / per-tx unlimited
    for (name, amount, ok) in [
        ("per-tx: exactly the limit", 400u64, true),
        ("per-tx: limit + 1", 401, false),
        ("per-tx: u64::MAX", u64::MAX, false),
        ("per-tx: zero", 0, true),
    ] {
        let want = if ok { W::Ok } else { W::Code(E::PerTxExceeded) };
        rows.push(case(name, K::Verify, St::Active, want, move |ix, _| {
            ix.data[AMOUNT].copy_from_slice(&amount.to_le_bytes())
        }));
    }
    for (name, amount, ok) in [
        ("lifetime: exactly the limit", 100u64, true),
        ("lifetime: limit + 1", 101, false),
        ("lifetime: u64::MAX does not wrap", u64::MAX, false),
        (
            "lifetime: u64::MAX - 100 does not wrap",
            u64::MAX - 100,
            false,
        ),
    ] {
        let want = if ok {
            W::Ok
        } else {
            W::Code(E::SpendLimitExceeded)
        };
        rows.push(case(name, K::Verify, St::Active, want, move |ix, fx| {
            ix.data[TARGET].copy_from_slice(fx.third.as_ref());
            ix.data[AMOUNT].copy_from_slice(&amount.to_le_bytes());
        }));
    }
    rows.push(v(
        "an unlimited permission accepts u64::MAX",
        St::Active,
        W::Ok,
        |ix, fx| {
            ix.data[TARGET].copy_from_slice(fx.other.as_ref());
            ix.data[DISCR].copy_from_slice(&OTHER_DISC);
            ix.data[AMOUNT].copy_from_slice(&u64::MAX.to_le_bytes());
        },
    ));
    rows.push(v(
        "the sixteenth slot is reachable",
        St::Full,
        W::Ok,
        |ix, fx| {
            let last = fx.e.data()[slot_base(15)..slot_base(15) + 32].to_vec();
            ix.data[TARGET].copy_from_slice(&last);
        },
    ));
    rows
}

fn all_rows() -> Vec<Case> {
    let mut rows = Vec::new();
    rows.extend(create_rows());
    rows.extend(owner_family_rows());
    rows.extend(add_rows());
    rows.extend(remove_update_rows());
    rows.extend(set_active_rows());
    rows.extend(revoke_rows());
    rows.extend(verify_rows());
    rows
}

#[test]
fn every_instruction_times_every_failure_has_its_documented_code() {
    let rows = all_rows();
    assert!(rows.len() >= 250, "the table shrank: {} rows", rows.len());
    let failures: Vec<String> = rows.iter().filter_map(|c| run_case(c).err()).collect();
    assert!(
        failures.is_empty(),
        "{} of {} rows failed:\n  {}",
        failures.len(),
        rows.len(),
        failures.join("\n  ")
    );
}

/// The table must exercise every documented error code (13 is reached through a
/// lamport-overflow setup, 1 through the dispatch tests below).
#[test]
fn the_table_covers_every_error_code() {
    let mut seen = std::collections::BTreeSet::new();
    for c in all_rows() {
        if let W::Code(code) = c.want {
            seen.insert(code as u32);
        }
    }
    seen.insert(E::InvalidDiscriminator as u32); // unknown_tags_* below
    let missing: Vec<u32> = (1..=22).filter(|c| !seen.contains(c)).collect();
    assert!(
        missing.is_empty(),
        "error codes no row asserts: {missing:?}"
    );
}

// --- dispatch --------------------------------------------------------------------

#[test]
fn every_unknown_tag_is_rejected_with_code_1() {
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE));
    let (o, m) = (e.owner_key(), e.mandate());
    let before = Snapshot::take(&e.svm, &[m]);
    for tag in 7u16..=255 {
        let mut data = vec![tag as u8];
        data.extend_from_slice(&[0u8; 100]);
        let ix = owner_ix(&o, &m, data);
        assert_code(e.run(ix), E::InvalidDiscriminator);
    }
    assert_eq!(before, Snapshot::take(&e.svm, &[m]));
}

#[test]
fn empty_instruction_data_is_code_15() {
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE));
    let ix = owner_ix(&e.owner_key(), &e.mandate(), vec![]);
    assert_code(e.run(ix), E::InvalidInstructionData);
}

#[test]
fn each_known_tag_with_no_payload_and_no_accounts_is_code_15() {
    let Some(mut e) = env() else { return };
    let payer = e.owner.insecure_clone();
    for tag in 0u8..=6 {
        let ix = Instruction::new_with_bytes(program_id(), &[tag], vec![]);
        assert_code(
            send(&mut e.svm, &[&payer], &[ix]),
            E::InvalidInstructionData,
        );
    }
}

#[test]
fn each_tag_reaches_its_own_handler() {
    // mutant: two tags routed to the same handler. Each tag is sent with the
    // payload of its own instruction and must succeed.
    let Some(mut e) = env() else { return };
    assert_ok(e.create(FUTURE)); // tag 0
    let t = Pubkey::new_unique();
    assert_ok(e.add(&t, 10, 5, &[DISC])); // tag 1
    assert_ok(e.update(&t, 20, 6)); // tag 6
    assert_ok(e.verify(&t, &DISC, 1)); // tag 3
    assert_ok(e.set_active(0)); // tag 5
    assert_ok(e.set_active(1));
    assert_ok(e.remove(&t)); // tag 2
    assert_ok(e.revoke()); // tag 4
    assert!(e.account().is_none());
}

// --- single-byte key differences ------------------------------------------------------

/// Flip one byte of a key stored in the mandate and check the program notices.
/// Mutants that compare 31 bytes, a prefix, or only a hash-like part of a key
/// survive every test that uses unrelated random keys.
#[test]
fn a_one_byte_difference_in_a_stored_key_is_detected() {
    for byte in [0usize, 1, 15, 30, 31] {
        // stored owner differs from the real owner: owner-signed and verify calls fail
        let Some((mut e, t)) = Env::with_permission(0, 0) else {
            return;
        };
        let owner_off = OFF_OWNER + byte;
        let flipped = e.data()[owner_off] ^ 0x80;
        e.patch(owner_off, &[flipped]);
        assert_code(e.set_active(0), E::NotOwner);
        assert_code(e.verify(&t, &DISC, 1), E::NotOwner);
        assert_code(e.revoke(), E::NotOwner);

        // stored agent differs from the real agent: verify refuses it
        let Some((mut e, t)) = Env::with_permission(0, 0) else {
            return;
        };
        let agent_off = OFF_AGENT + byte;
        let flipped = e.data()[agent_off] ^ 0x80;
        e.patch(agent_off, &[flipped]);
        assert_code(e.verify(&t, &DISC, 1), E::UnknownAgent);

        // stored program key differs from the reported one: no slot matches
        let Some((mut e, t)) = Env::with_permission(0, 0) else {
            return;
        };
        let key_off = slot_base(0) + P_PROGRAM_ID + byte;
        let flipped = e.data()[key_off] ^ 0x80;
        e.patch(key_off, &[flipped]);
        assert_code(e.verify(&t, &DISC, 1), E::ProgramNotAllowed);
        assert_code(e.remove(&t), E::PermissionNotFound);
        assert_code(e.update(&t, 1, 1), E::PermissionNotFound);
        // and add sees no duplicate
        assert_ok(e.add(&t, 1, 1, &[DISC]));
    }
}

/// The same for the 8-byte discriminator.
#[test]
fn a_one_byte_difference_in_a_discriminator_is_detected() {
    let Some((mut e, t)) = Env::with_permission(0, 0) else {
        return;
    };
    for byte in 0..8 {
        let mut d = DISC;
        d[byte] ^= 0x01;
        assert_code(e.verify(&t, &d, 1), E::DiscriminatorNotAllowed);
    }
    assert_ok(e.verify(&t, &DISC, 1));
}
