#!/usr/bin/env python3
"""Read-only fetch of a Raydium CP-Swap devnet pool fixture for SW-15.

Uses only getProgramAccounts / getMultipleAccounts on a public devnet RPC (no signing, no
transactions). Picks the pool with the deepest classic-Token reserves on both sides and writes
`devnet_pool.json` next to this script. The program binary is dumped separately:

    solana program dump DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb cpmm_devnet.so -u devnet

Run:  python3 -I fetch_fixture.py [rpc_url]
"""
import base64
import json
import os
import sys
import urllib.request

RPC = sys.argv[1] if len(sys.argv) > 1 else "https://api.devnet.solana.com"
CPMM = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + out


def rpc(method, params):
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        out = json.load(r)
    if "error" in out:
        raise SystemExit(f"{method}: {out['error']}")
    return out["result"]


def main():
    pools = rpc(
        "getProgramAccounts",
        [CPMM, {"encoding": "base64", "dataSlice": {"offset": 0, "length": 381},
                "filters": [{"dataSize": 637}]}],
    )
    print(f"{len(pools)} pool accounts")
    cands = []
    for p in pools:
        d = base64.b64decode(p["account"]["data"][0])
        key = lambda o: b58(d[o:o + 32])
        if key(232) != TOKEN or key(264) != TOKEN or d[329] != 0:
            continue
        cands.append({"pool": p["pubkey"], "config": key(8), "vault0": key(72), "vault1": key(104),
                      "mint0": key(168), "mint1": key(200), "obs": key(296)})
    print(f"{len(cands)} classic-Token pools with status 0")
    best, best_depth = None, 0
    for i in range(0, min(len(cands), 3000), 50):
        chunk = cands[i:i + 50]
        keys = [c["vault0"] for c in chunk] + [c["vault1"] for c in chunk]
        res = rpc("getMultipleAccounts", [keys, {"encoding": "base64", "dataSlice": {"offset": 64, "length": 8}}])["value"]
        for j, c in enumerate(chunk):
            a, b = res[j], res[j + len(chunk)]
            if not a or not b:
                continue
            r0 = int.from_bytes(base64.b64decode(a["data"][0]), "little")
            r1 = int.from_bytes(base64.b64decode(b["data"][0]), "little")
            depth = min(r0, r1)
            if depth > best_depth and max(r0, r1) < 10**15:  # skip junk pools with near-u64 reserves
                best, best_depth = c, depth
    if not best:
        raise SystemExit("no usable pool")
    names = ["pool", "config", "vault0", "vault1", "mint0", "mint1", "obs"]
    keys = [best[n] for n in names]
    res = rpc("getMultipleAccounts", [keys, {"encoding": "base64"}])
    fixture = {"program": CPMM, "rpc": RPC, "slot": rpc("getSlot", []), "accounts": {}}
    for n, k, a in zip(names, keys, res["value"]):
        fixture["accounts"][n] = {"key": k, "owner": a["owner"], "lamports": a["lamports"],
                                  "data_base64": a["data"][0]}
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "devnet_pool.json")
    with open(path, "w") as f:
        json.dump(fixture, f, indent=1)
    print("wrote", path, "pool", best["pool"], "min reserve", best_depth)


main()
