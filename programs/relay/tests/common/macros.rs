//! `dual_token!`: run one test body against both token binaries.
//!
//! Required in the calling test file (the macro expands to bare names):
//!
//! ```ignore
//! #[macro_use]
//! mod common;
//! use common::*;
//! ```
//!
//! Forms (each expands to a module `<name>` containing `#[test] fn classic()` and
//! `#[test] fn ptoken()`, so `cargo test transfer_happy` runs both):
//!
//! ```ignore
//! dual_token!(transfer_happy, |ctx| {
//!     ctx.send_agent(&[ctx.transfer_ix(1_000)]).assert_ok();
//! });
//!
//! // customise the fixture:
//! dual_token!(per_tx_boundary, with |b| b.limits(1_000_000, 100), |ctx| {
//!     ctx.send_agent(&[ctx.transfer_ix(101)]).assert_aa_err(aa_err::PER_TX_EXCEEDED);
//! });
//! ```
//!
//! `triple_token!` additionally runs `fn token2022()` with `Flavor::Token2022`.
//!
//! With `AGENT_AUTH_ALLOW_SKIP=1` and a missing `.so` the body is skipped; otherwise a missing
//! `.so` is a hard failure.

#[allow(unused_macros)]
macro_rules! token_flavor_tests {
    ($name:ident, [$(($fn_name:ident, $flavor:expr)),+], $b:ident, $cfg:expr, $ctx:ident, $body:block) => {
        mod $name {
            #[allow(unused_imports)]
            use super::*;

            #[allow(unused_variables, unused_mut, clippy::redundant_closure_call)]
            fn body($ctx: &mut Ctx) $body

            fn run(flavor: Flavor) {
                let $b = Ctx::builder(flavor);
                let builder: CtxBuilder = $cfg;
                let Some(mut c) = builder.try_build() else {
                    return;
                };
                body(&mut c);
            }

            $(
                #[test]
                fn $fn_name() {
                    run($flavor);
                }
            )+
        }
    };
}

/// Run a test body on classic spl-token and on p-token.
#[allow(unused_macros)]
macro_rules! dual_token {
    ($name:ident, |$ctx:ident| $body:block) => {
        token_flavor_tests!(
            $name,
            [(classic, Flavor::Classic), (ptoken, Flavor::PToken)],
            b__,
            b__,
            $ctx,
            $body
        );
    };
    ($name:ident, with |$b:ident| $cfg:expr, |$ctx:ident| $body:block) => {
        token_flavor_tests!(
            $name,
            [(classic, Flavor::Classic), (ptoken, Flavor::PToken)],
            $b,
            $cfg,
            $ctx,
            $body
        );
    };
}

/// Run a test body on classic spl-token, p-token and Token-2022.
#[allow(unused_macros)]
macro_rules! triple_token {
    ($name:ident, |$ctx:ident| $body:block) => {
        token_flavor_tests!(
            $name,
            [
                (classic, Flavor::Classic),
                (ptoken, Flavor::PToken),
                (token2022, Flavor::Token2022)
            ],
            b__,
            b__,
            $ctx,
            $body
        );
    };
    ($name:ident, with |$b:ident| $cfg:expr, |$ctx:ident| $body:block) => {
        token_flavor_tests!(
            $name,
            [
                (classic, Flavor::Classic),
                (ptoken, Flavor::PToken),
                (token2022, Flavor::Token2022)
            ],
            $b,
            $cfg,
            $ctx,
            $body
        );
    };
}

/// Loop form for table-driven tests inside one `#[test]`: `for_flavors(&Flavor::DUAL, |flavor| ...)`.
pub fn for_flavors(flavors: &[super::svm::Flavor], mut f: impl FnMut(super::svm::Flavor)) {
    for fl in flavors {
        f(*fl);
    }
}
