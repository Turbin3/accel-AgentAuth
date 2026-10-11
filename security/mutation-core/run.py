#!/usr/bin/env python3
"""Mutation runner for the core program (src/**). One mutant at a time, on a scratch copy.

For each selected mutant: restore the pristine source, apply the exact text edit(s) from
mutants.json, rebuild the .so with `cargo build-sbf`, run the root crate's test suite with the
environment of scripts/env.sh (AGENT_AUTH_SO pointing at the mutant .so, AGENT_AUTH_ALLOW_SKIP
unset), and record killed / survived plus the first failing test.

The working tree is never modified: everything happens in a copy under $TMPDIR (or --scratch).

  python3 security/mutation-core/run.py --control                  # unmutated build must pass
  python3 security/mutation-core/run.py --ids X02,V08,N-S31        # three mutants
  python3 security/mutation-core/run.py --all                      # whole campaign (hours)
  python3 security/mutation-core/run.py --set legacy99 --ids R7    # the earlier 99-mutant set
  python3 security/mutation-core/run.py --list

Options: --repo DIR  --scratch DIR  --target DIR (CARGO_TARGET_DIR, default <scratch>/target; point
it at a warm copy to skip the cold build)  --out FILE (jsonl, default <scratch>/results.jsonl)
--all-failures (cargo test --no-fail-fast)  --keep (keep the scratch copy)  --timeout SECONDS.
"""
import argparse, csv, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
COPY = ["Cargo.toml", "Cargo.lock", "src", "tests", "fixtures", "idl", "programs", "crates", "scripts", "LICENSE", "README.md"]
SETS = {"main": ("mutants.json", "results.csv"), "legacy99": ("mutants-legacy99.json", "results-legacy99.csv")}


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
    olds = m["old"] if isinstance(m["old"], list) else [m["old"]]
    news = m["new"] if isinstance(m["new"], list) else [m["new"]]
    assert len(olds) == len(news), m["id"]
    return list(zip(olds, news))


def apply_mutant(m, root):
    path = os.path.join(root, m["file"])
    text = open(path).read()
    orig = text
    for old, new in edits_of(m):
        nth = m.get("occurrence")
        if nth is None:
            if text.count(old) != 1:
                raise SystemExit(f"{m['id']}: the old text must occur exactly once, found {text.count(old)}x (source drifted from the catalogue?)")
            text = text.replace(old, new, 1)
        else:
            pos = -1
            for _ in range(nth):
                pos = text.index(old, pos + 1)
            text = text[:pos] + new + text[pos + len(old):]
    if text == orig:
        raise SystemExit(f"{m['id']}: no-op mutant")
    open(path, "w").write(text)  # a fresh mtime matters: cargo must notice the change
    return orig, path


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
    ap.add_argument("--set", choices=list(SETS), default="main")
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
    ap.add_argument("--timeout", type=int, default=1800)
    a = ap.parse_args()

    mfile, rfile = SETS[a.set]
    mutants = json.load(open(os.path.join(HERE, mfile)))
    ledger = {r["id"]: r for r in csv.DictReader(open(os.path.join(HERE, rfile)))}
    by_id = {m["id"]: m for m in mutants}
    if a.list:
        for m in mutants:
            print(f"{m['id']:8} {ledger[m['id']]['status']:10} {m['file']:42} {m['description']}")
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

    scratch = os.path.abspath(a.scratch or tempfile.mkdtemp(prefix="agentauth-mutcore-"))
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

    test_cmd = "cargo test" + (" --no-fail-fast" if a.all_failures else "")
    # scripts/env.sh exports the *_SO variables for $CARGO_TARGET_DIR; the mutant's .so replaces the core one.
    shell = f'source scripts/env.sh && export AGENT_AUTH_SO="$MUT_SO" && {test_cmd}'
    todo = (["CONTROL"] if a.control else []) + ids
    results, bad = [], 0
    for mid in todo:
        t0 = time.time()
        m = by_id.get(mid)
        orig = path = None
        rec = {"id": mid, "set": a.set}
        try:
            if m:
                orig, path = apply_mutant(m, work)
            so_dir = os.path.join(scratch, "out", mid)
            os.makedirs(so_dir, exist_ok=True)
            rc, bout = sh(["cargo", "build-sbf", "--manifest-path", "Cargo.toml", "--sbf-out-dir", so_dir], work, env, a.timeout, os.path.join(logs, mid + ".build.log"))
            so = os.path.join(so_dir, "agent_auth.so")
            if rc != 0 or not os.path.exists(so):
                rec.update(status="error", detail="cargo build-sbf failed, see " + os.path.join(logs, mid + ".build.log"))
            else:
                e2 = dict(env, MUT_SO=so)
                rc, tout = sh(["bash", "-c", shell], work, e2, a.timeout, os.path.join(logs, mid + ".test.log"))
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
            if m and orig is not None:
                open(path, "w").write(orig)
        rec["seconds"] = round(time.time() - t0)
        exp = ledger.get(mid, {}).get("status")
        if mid == "CONTROL":
            ok = rec["status"] == "survived"; exp = "tests pass on unmutated source"
        else:
            ok = {"killed": rec["status"] == "killed", "equivalent": rec["status"] == "survived"}.get(exp, False)
        rec["ledger"] = exp
        rec["agrees_with_ledger"] = ok
        bad += 0 if ok else 1
        with open(out_file, "a") as f:
            f.write(json.dumps(rec) + "\n")
        first = (rec.get("failed") or [""])[0]
        print(f"{mid:8} run={rec['status']:9} ledger={exp:10} {'OK' if ok else 'MISMATCH'}  {rec['seconds']:5}s  {first}", flush=True)
    if not a.keep and not a.scratch:
        shutil.rmtree(scratch, ignore_errors=True)
    elif a.keep:
        print("kept", scratch)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
