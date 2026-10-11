#!/usr/bin/env python3
"""Mutation runner for the relay program (programs/relay/src/**). One mutant at a time, on a scratch copy.

For each selected mutant: restore the pristine source, apply the exact text edit(s) from
mutants.json, rebuild BOTH relay .so files (default features and `--features test-amm`) with
`cargo build-sbf`, run `cargo test -p agent-auth-relay` with the environment of scripts/env.sh
(AGENT_AUTH_RELAY_SO and AGENT_AUTH_RELAY_TESTAMM_SO pointing at the mutant builds,
AGENT_AUTH_ALLOW_SKIP unset), and record killed / survived plus the first failing test.

The working tree is never modified: everything happens in a copy under $TMPDIR (or --scratch).
Before the first mutant the runner runs scripts/build-all.sh in the copy (idempotent; a warm
--target makes it nearly free) because the relay suite also loads the other programs.

  python3 security/mutation-relay/run.py --control                 # unmutated build must pass
  python3 security/mutation-relay/run.py --ids C01,D04,V16          # three mutants
  python3 security/mutation-relay/run.py --all                      # whole campaign (many hours)
  python3 security/mutation-relay/run.py --ids D04 --without-witness   # D04 survives without witness.rs
  python3 security/mutation-relay/run.py --list

Options: --repo DIR  --scratch DIR  --target DIR (CARGO_TARGET_DIR, default <scratch>/target; point
it at a warm copy to skip the cold build)  --out FILE (jsonl, default <scratch>/results.jsonl)
--all-failures (cargo test --no-fail-fast)  --set redteam15 / --with-redteam (run with the red-team suites installed)  --without-witness (delete programs/relay/tests/witness.rs
from the copy: reproduces the first campaign pass, in which 40 mutants survived)  --keep
--skip-build (do not run build-all.sh)  --timeout SECONDS.
"""
import argparse, csv, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
COPY = ["Cargo.toml", "Cargo.lock", "src", "tests", "fixtures", "idl", "programs", "crates", "scripts", "LICENSE", "README.md"]
SETS = {"main": ("mutants.json", "results.csv"), "redteam15": ("mutants-redteam15.json", "results-redteam15.csv")}


def sh(cmd, cwd, env, timeout, log=None):
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
        out, rc = p.stdout, p.returncode
    except subprocess.TimeoutExpired as e:
        out, rc = "TIMEOUT\n" + str(e.stdout or ""), "TIMEOUT"
    if log:
        with open(log, "w") as f:
            f.write(out)
    return rc, out


def edits_of(m):
    if m.get("edits"):
        return [(e["file"], e["old"], e["new"], 1) for e in m["edits"]]
    return [(m["file"], m["old"], m["new"], m.get("count", 1))]


def apply_mutant(m, root):
    saved = {}
    for f, old, new, count in edits_of(m):
        path = os.path.join(root, f)
        text = open(path).read()
        saved.setdefault(path, text)
        if text.count(old) != count:
            raise SystemExit(f"{m['id']}: the old text must occur {count}x in {f}, found {text.count(old)}x (source drifted from the catalogue?)")
        open(path, "w").write(text.replace(old, new))  # a fresh mtime matters: cargo must notice the change
    return saved


def restore(saved):
    for path, text in saved.items():
        open(path, "w").write(text)


def parse(out):
    running, fails = None, []
    for ln in out.splitlines():
        mm = re.match(r"\s+Running (.+?)(?: \(|$)", ln)
        if mm:
            running = mm.group(1).strip()
        mm = re.match(r"\s+Doc-tests", ln)
        mf = re.match(r"test (\S+) \.\.\. FAILED", ln)
        if mf:
            fails.append(f"{running}::{mf.group(1)}")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", choices=list(SETS), default="main", help="main: the 257-mutant campaign; redteam15: the 15 mutants of the red-team pass")
    ap.add_argument("--ids")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--control", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--repo", default=os.path.abspath(os.path.join(HERE, "..", "..")))
    ap.add_argument("--scratch")
    ap.add_argument("--target")
    ap.add_argument("--out")
    ap.add_argument("--all-failures", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--without-witness", action="store_true")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--with-redteam", action="store_true", help="install security/redteam-relay into the copy (implied by --set redteam15); RT_ITERS defaults to 300")
    ap.add_argument("--timeout", type=int, default=1800)
    a = ap.parse_args()

    mfile, rfile = SETS[a.set]
    mutants = json.load(open(os.path.join(HERE, mfile)))
    ledger = {r["id"]: r for r in csv.DictReader(open(os.path.join(HERE, rfile)))}
    by_id = {m["id"]: m for m in mutants}
    if a.list:
        for m in mutants:
            print(f"{m['id']:8} {ledger[m['id']]['status']:10} {m['file'].replace('programs/relay/src/', ''):22} {m['description']}")
        return
    if a.all:
        ids = [m["id"] for m in mutants]
    elif a.ids:
        ids = a.ids.split(",")
        for i in ids:
            if i not in by_id:
                sys.exit(f"unknown mutant id {i} (see --list)")
    else:
        ids = []
    if not ids and not a.control:
        sys.exit("nothing to do: pass --control, --ids A,B or --all")

    scratch = os.path.abspath(a.scratch or tempfile.mkdtemp(prefix="agentauth-mutrelay-"))
    os.makedirs(scratch, exist_ok=True)
    work = os.path.join(scratch, "repo")
    target = os.path.abspath(a.target or os.path.join(scratch, "target"))
    out_file = a.out or os.path.join(scratch, "results.jsonl")
    logs = os.path.join(scratch, "logs")
    os.makedirs(logs, exist_ok=True)
    if os.path.exists(work):
        shutil.rmtree(work)
    os.makedirs(work)
    for name in COPY:
        s = os.path.join(a.repo, name)
        if os.path.isdir(s):
            shutil.copytree(s, os.path.join(work, name), ignore=shutil.ignore_patterns("target", "node_modules", ".git"))
        elif os.path.exists(s):
            shutil.copy2(s, os.path.join(work, name))
    print(f"scratch copy: {work}\ncargo target: {target}\nresults:      {out_file}", flush=True)

    env = dict(os.environ)
    env["PATH"] = os.path.expanduser("~/.cargo/bin") + os.pathsep + env["PATH"]  # rustup's cargo must shadow Homebrew's
    env["CARGO_TARGET_DIR"] = target
    env.pop("AGENT_AUTH_ALLOW_SKIP", None)  # a missing .so must be a hard failure, never a silent skip

    if a.without_witness:
        w = os.path.join(work, "programs", "relay", "tests", "witness.rs")
        if os.path.exists(w):
            os.remove(w)
    if a.with_redteam or a.set == "redteam15":
        rt = os.path.join(HERE, "..", "redteam-relay")
        td = os.path.join(work, "programs", "relay", "tests")
        for n in ("redteam_attacks.rs", "redteam_attacks2.rs", "redteam_fuzz.rs"):
            shutil.copy(os.path.join(rt, n), td)
        shutil.copytree(os.path.join(rt, "redteam_util"), os.path.join(td, "redteam_util"))
        env.setdefault("RT_ITERS", "300")
    if not a.skip_build:
        t0 = time.time()
        print("scripts/build-all.sh (baseline of every program) ...", flush=True)
        rc, bout = sh(["bash", "scripts/build-all.sh"], work, env, 4 * a.timeout, os.path.join(logs, "build-all.log"))
        if rc != 0:
            sys.exit("scripts/build-all.sh failed, see " + os.path.join(logs, "build-all.log"))
        print(f"  baseline build {round(time.time() - t0)}s", flush=True)

    test_cmd = "cargo test -p agent-auth-relay" + (" --no-fail-fast" if a.all_failures else "")
    # scripts/env.sh exports every *_SO variable for $CARGO_TARGET_DIR; the two relay variables are
    # then pointed at the mutant builds so the shared target never holds a mutant.
    shell = ('source scripts/env.sh && export AGENT_AUTH_RELAY_SO="$MUT_DIR/deploy/agent_auth_relay.so" '
             'AGENT_AUTH_RELAY_TESTAMM_SO="$MUT_DIR/deploy-localnet/agent_auth_relay.so" && ' + test_cmd)
    todo = (["CONTROL"] if a.control else []) + ids
    bad = 0
    for mid in todo:
        t0 = time.time()
        m = by_id.get(mid)
        saved = {}
        rec = {"id": mid, "witness": not a.without_witness}
        try:
            if m:
                saved = apply_mutant(m, work)
            mdir = os.path.join(scratch, "out", mid)
            os.makedirs(mdir, exist_ok=True)
            manifest = ["cargo", "build-sbf", "--manifest-path", "programs/relay/Cargo.toml"]
            r1, _ = sh(manifest + ["--sbf-out-dir", os.path.join(mdir, "deploy")], work, env, a.timeout, os.path.join(logs, mid + ".build1.log"))
            r2, _ = sh(manifest + ["--features", "test-amm", "--sbf-out-dir", os.path.join(mdir, "deploy-localnet")], work, env, a.timeout, os.path.join(logs, mid + ".build2.log"))
            if r1 != 0 or r2 != 0:
                rec.update(status="error", detail="cargo build-sbf failed, see " + os.path.join(logs, mid + ".build*.log"))
            else:
                rc, tout = sh(["bash", "-c", shell], work, dict(env, MUT_DIR=mdir), a.timeout, os.path.join(logs, mid + ".test.log"))
                fails = parse(tout)
                if rc == 0:
                    rec["status"] = "survived"
                elif rc == "TIMEOUT":
                    rec["status"] = "killed"; rec["detail"] = "test run timed out (counted as killed, inspect the log)"
                elif fails:
                    rec["status"] = "killed"
                else:
                    rec.update(status="error", detail="cargo test failed without a failing test (test build error?), see " + os.path.join(logs, mid + ".test.log"))
                rec["failed"] = fails[:6]
        finally:
            restore(saved)
        rec["seconds"] = round(time.time() - t0)
        row = ledger.get(mid, {})
        if mid == "CONTROL":
            exp, ok = "tests pass on unmutated source", rec["status"] == "survived"
        elif a.without_witness:
            exp = "survived" if row.get("first_run") == "survived" or row.get("status") == "equivalent" else "killed"   # first campaign pass
            ok = rec["status"] == exp
        else:
            exp = row.get("status")
            ok = {"killed": rec["status"] == "killed", "equivalent": rec["status"] == "survived"}.get(exp, False)
        rec["expected"] = exp
        rec["agrees_with_ledger"] = ok
        bad += 0 if ok else 1
        with open(out_file, "a") as f:
            f.write(json.dumps(rec) + "\n")
        first = (rec.get("failed") or [""])[0]
        print(f"{mid:8} run={rec['status']:9} expected={exp:10} {'OK' if ok else 'MISMATCH'}  {rec['seconds']:5}s  {first}", flush=True)
    if not a.keep and not a.scratch:
        shutil.rmtree(scratch, ignore_errors=True)
    elif a.keep:
        print("kept", scratch)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
