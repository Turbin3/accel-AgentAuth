# Same entry points as CI (.github/workflows/ci.yml). Needs: rustup cargo, Solana CLI (cargo build-sbf,
# solana-test-validator), Node >= 20, pnpm 10.
SHELL := /usr/bin/env bash
export PATH := $(HOME)/.cargo/bin:$(HOME)/.local/share/solana/install/active_release/bin:$(PATH)

.PHONY: help install build test lint e2e demo clean

help:
	@echo "make build   build every on-chain program (scripts/build-all.sh) and every TS package"
	@echo "make test    build + cargo test --workspace + pnpm -r test (scripts/test-all.sh)"
	@echo "make lint    fmt, clippy -D warnings, typecheck, lint (scripts/lint-all.sh)"
	@echo "make e2e     localnet end to end: demo smoke (--relay) and the CLI e2e. Needs the validator."
	@echo "make demo    localnet + bootstrap + scripted scenario and attack runner (scripted, not a live agent)"

install:
	pnpm install --frozen-lockfile

build:
	scripts/build-all.sh
	pnpm -r --if-present run build

test:
	scripts/test-all.sh

lint:
	scripts/lint-all.sh

# Instance 1 keeps the e2e off the default localnet (8899) in case a developer validator is running.
# The validator is stopped on success and on failure.
e2e: build
	@set -e; trap 'AA_LOCALNET_INSTANCE=1 scripts/localnet.sh stop >/dev/null 2>&1 || true' EXIT; \
	AA_LOCALNET_INSTANCE=1 scripts/localnet.sh start; \
	eval "$$(AA_LOCALNET_INSTANCE=1 scripts/localnet.sh env)"; \
	pnpm --filter @agentauth-sol/demo bootstrap; \
	pnpm --filter @agentauth-sol/demo smoke --relay; \
	AA_E2E_TRANSCRIPT="$${AA_E2E_TRANSCRIPT:-/tmp/agentauth-cli-e2e.txt}" AA_LOCALNET_INSTANCE=2 packages/cli/test/e2e.sh

demo: build
	@set -e; trap 'scripts/localnet.sh stop >/dev/null 2>&1 || true' EXIT; \
	scripts/localnet.sh start; \
	pnpm --filter @agentauth-sol/demo bootstrap; \
	pnpm --filter @agentauth-sol/demo scenario; \
	pnpm --filter @agentauth-sol/demo attacks

clean:
	cargo clean
	rm -rf .demo
