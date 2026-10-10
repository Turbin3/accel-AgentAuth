import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  programs, getProgramById, getProgramBySlug, instructionByName, decodeInstruction,
  canonicalDisc8, riskOf, isDefaultDeny, parseAmount, presets, preset,
} from '../src/index.js'
import { anchorDisc } from '../scripts/disc.js'

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SYSTEM = '11111111111111111111111111111111'
const RAYDIUM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
const RAYDIUM_DEV = 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

const le64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }

test('lookup helpers', () => {
  assert.equal(getProgramById(TOKEN).slug, 'spl-token')
  assert.equal(getProgramById(TOKEN, 'devnet').slug, 'spl-token')
  assert.equal(getProgramById(RAYDIUM_DEV, 'mainnet-beta'), null)
  assert.equal(getProgramById(RAYDIUM_DEV, 'devnet').slug, 'raydium-cpmm')
  assert.equal(getProgramById('nope'), null)
  assert.equal(getProgramBySlug('system').name, programs.find((p) => p.slug === 'system').name)
  assert.equal(getProgramBySlug('nope'), null)
  assert.equal(instructionByName('spl-token', 'transfer_checked').disc8, '0c00000000000000')
  assert.equal(instructionByName(TOKEN, 'transfer_checked').disc8, '0c00000000000000')
  assert.equal(instructionByName(TOKEN, 'nope'), null)
  assert.equal(instructionByName('nope', 'x'), null)
})

test('every program id is unique across programs', () => {
  const seen = new Map()
  for (const p of programs) for (const id of Object.values(p.programIds)) {
    assert.ok(!seen.has(id) || seen.get(id) === p.slug, `${id} used by two programs`)
    seen.set(id, p.slug)
  }
})

test('decode SPL Token transfer_checked and round trip', () => {
  const data = Buffer.concat([Buffer.from([0x0c]), le64(1_500_000), Buffer.from([6])])
  for (const input of [data, data.toString('hex'), '0x' + data.toString('hex'), new Uint8Array(data), [...data]]) {
    const r = decodeInstruction(TOKEN, input)
    assert.equal(r.known, true)
    assert.equal(r.program.slug, 'spl-token')
    assert.equal(r.instruction.name, 'transfer_checked')
    assert.equal(r.disc8, '0c00000000000000')
    assert.equal(r.risk, 'value_out')
    assert.equal(r.defaultDeny, false)
  }
  assert.equal(canonicalDisc8(TOKEN, data), '0c00000000000000')
  assert.equal(riskOf(TOKEN, '0c00000000000000'), 'value_out')
  assert.equal(instructionByName('spl-token', r2(data)).disc8, canonicalDisc8(TOKEN, data))
})
function r2(d) { return decodeInstruction(TOKEN, d).instruction.name }

test('canonical disc8 never leaks the amount (transfer)', () => {
  const data = Buffer.concat([Buffer.from([3]), le64(0xdeadbeef)])
  assert.equal(canonicalDisc8(TOKEN, data), '0300000000000000')
  assert.equal(canonicalDisc8(TOKEN22, data), '0300000000000000')
})

test('decode System transfer (u32 LE tag)', () => {
  const data = Buffer.concat([Buffer.from([2, 0, 0, 0]), le64(5_000_000_000)])
  const r = decodeInstruction(SYSTEM, data)
  assert.equal(r.instruction.name, 'transfer')
  assert.equal(r.disc8, '0200000000000000')
  assert.equal(r.risk, 'value_out')
  assert.equal(parseAmount(SYSTEM, data), 5_000_000_000n)
})

test('decode Raydium swap_base_input', () => {
  const data = Buffer.concat([Buffer.from('8fbe5adac41e33de', 'hex'), le64(1000), le64(900)])
  const r = decodeInstruction(RAYDIUM, data)
  assert.equal(r.instruction.name, 'swap_base_input')
  assert.equal(r.disc8, '8fbe5adac41e33de')
  assert.equal(r.disc8, anchorDisc('swap_base_input'))
  assert.equal(r.risk, 'value_swap')
  assert.equal(parseAmount(RAYDIUM, data), 1000n)
  assert.equal(decodeInstruction(RAYDIUM_DEV, data, 'devnet').instruction.name, 'swap_base_input')
  assert.equal(decodeInstruction(RAYDIUM_DEV, data, 'mainnet-beta').known, false)
})

test('Token-2022 extension instructions use tag + sub-tag', () => {
  const r = decodeInstruction(TOKEN22, Buffer.concat([Buffer.from([0x1a, 0x01]), le64(7), Buffer.from([2])]))
  assert.equal(r.instruction.name, 'transfer_checked_with_fee')
  assert.equal(r.disc8, '1a01000000000000')
  // unknown sub-tag keeps the 2-byte convention
  const u = decodeInstruction(TOKEN22, Buffer.from([0x1a, 0xee, 1, 2, 3]))
  assert.equal(u.known, false)
  assert.equal(u.disc8, '1aee000000000000')
})

test('unknown instruction in a known program', () => {
  const t = decodeInstruction(TOKEN, Buffer.from([0xee, 1, 2, 3]))
  assert.deepEqual([t.known, t.instruction, t.disc8, t.risk, t.defaultDeny], [false, null, 'ee00000000000000', 'unknown', false])
  assert.equal(t.program.slug, 'spl-token')
  const a = decodeInstruction(RAYDIUM, Buffer.from('0102030405060708aabb', 'hex'))
  assert.deepEqual([a.known, a.disc8], [false, '0102030405060708'])
  assert.equal(decodeInstruction(RAYDIUM, Buffer.from('01020304', 'hex')).disc8, null) // too short for Anchor
  assert.equal(decodeInstruction(SYSTEM, Buffer.from([0xff, 0xff, 0xff, 0x7f, 9])).disc8, 'ffffff7f00000000')
  assert.equal(decodeInstruction(TOKEN, new Uint8Array(0)).disc8, null)
})

test('unknown program', () => {
  const r = decodeInstruction('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', '0102')
  assert.deepEqual(r, { known: false, program: null, instruction: null, disc8: null, risk: 'unknown', defaultDeny: false })
  assert.equal(riskOf('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', '0000000000000000'), null)
  assert.equal(parseAmount('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', '0102'), null)
})

test('bad input types throw', () => {
  assert.throws(() => decodeInstruction(TOKEN, 'abc'), TypeError)
  assert.throws(() => decodeInstruction(TOKEN, 'zz'), TypeError)
  assert.throws(() => decodeInstruction(TOKEN, 42), TypeError)
})

test('memo has no discriminator: any data is a memo with constant disc8', () => {
  for (const d of ['', Buffer.from('hi'), Buffer.from('a longer memo text')]) {
    const r = decodeInstruction(MEMO, d)
    assert.equal(r.instruction.name, 'memo')
    assert.equal(r.disc8, '0000000000000000')
    assert.equal(r.risk, 'read_only')
  }
})

test('ATA: tags and the empty-data legacy Create', () => {
  assert.equal(decodeInstruction(ATA, Buffer.from([1])).instruction.name, 'create_idempotent')
  assert.equal(decodeInstruction(ATA, Buffer.from([2])).instruction.name, 'recover_nested')
  const e = decodeInstruction(ATA, new Uint8Array(0))
  assert.equal(e.instruction.name, 'create')
  assert.equal(e.disc8, '0000000000000000')
})

test('parseAmount: transfer_checked, transfer, null cases', () => {
  const tc = Buffer.concat([Buffer.from([0x0c]), le64(123_456_789), Buffer.from([9])])
  assert.equal(parseAmount(TOKEN, tc), 123_456_789n)
  assert.equal(parseAmount(TOKEN22, tc), 123_456_789n)
  const tr = Buffer.concat([Buffer.from([3]), le64(2n ** 64n - 1n)])
  assert.equal(parseAmount(TOKEN, tr), 2n ** 64n - 1n)
  assert.equal(parseAmount(TOKEN, Buffer.from([0x0c, 1, 2])), null) // truncated
  assert.equal(parseAmount(TOKEN, Buffer.from([0x09])), null) // close_account has no amount
  assert.equal(parseAmount(TOKEN, Buffer.from([0xee, 0, 0, 0, 0, 0, 0, 0, 0])), null) // unknown
  assert.equal(parseAmount(MEMO, Buffer.from('hello world')), null)
  // Token-2022 transfer_checked_with_fee: amount after the 2-byte prefix
  assert.equal(parseAmount(TOKEN22, Buffer.concat([Buffer.from([0x1a, 1]), le64(77), Buffer.from([2, 1, 0, 0, 0, 0, 0, 0, 0])])), 77n)
})

test('parseAmount for every instruction with a descriptor reads the right slot', () => {
  for (const p of programs) {
    const id = Object.values(p.programIds)[0]
    for (const ix of p.instructions.filter((i) => i.amount)) {
      const a = ix.amount
      const data = Buffer.alloc(Math.max(a.offset + a.size, ix.rawPrefixHex.length / 2) + 8)
      Buffer.from(ix.rawPrefixHex, 'hex').copy(data)
      if (a.size === 8) data.writeBigUInt64LE(0x0102030405060708n, a.offset); else data.writeUInt32LE(0x01020304, a.offset)
      const r = decodeInstruction(id, data)
      assert.equal(r.instruction?.name, ix.name, `${p.slug}.${ix.name} decodes`)
      assert.equal(parseAmount(id, data), a.size === 8 ? 0x0102030405060708n : 0x01020304n, `${p.slug}.${ix.name}`)
    }
  }
})

test('every instruction round-trips through decode, riskOf and isDefaultDeny', () => {
  let n = 0
  for (const p of programs) {
    const id = Object.values(p.programIds)[0]
    for (const ix of p.instructions) {
      const data = Buffer.concat([Buffer.from(ix.rawPrefixHex, 'hex'), Buffer.alloc(24, 0xab)])
      const r = decodeInstruction(id, data)
      assert.equal(r.instruction?.name, ix.name, `${p.slug}.${ix.name}`)
      assert.equal(r.disc8, ix.disc8)
      assert.equal(canonicalDisc8(id, data), ix.disc8)
      assert.equal(riskOf(id, ix.disc8), ix.risk)
      assert.equal(isDefaultDeny(id, ix.disc8), ix.defaultDeny)
      n++
    }
  }
  assert.ok(n > 200)
})

test('every defaultDeny rule: authority_change, account_close and admin are always denied', () => {
  let denied = 0
  for (const p of programs) {
    const id = Object.values(p.programIds)[0]
    for (const ix of p.instructions) {
      if (['authority_change', 'account_close', 'admin'].includes(ix.risk)) assert.equal(ix.defaultDeny, true, `${p.slug}.${ix.name}`)
      if (ix.defaultDeny) {
        denied++
        assert.equal(isDefaultDeny(id, ix.disc8), true)
        assert.equal(decodeInstruction(id, Buffer.concat([Buffer.from(ix.rawPrefixHex, 'hex'), Buffer.alloc(16)])).defaultDeny, true)
      }
      if (['read_only', 'value_swap', 'position_mgmt'].includes(ix.risk)) assert.equal(ix.defaultDeny, false, `${p.slug}.${ix.name}`)
    }
  }
  assert.ok(denied > 50)
})

test('well-known dangerous instructions are default-deny', () => {
  const must = [
    ['spl-token', 'set_authority'], ['spl-token', 'approve'], ['spl-token', 'close_account'],
    ['spl-token-2022', 'set_authority'], ['spl-token-2022', 'close_account'],
    ['system', 'assign'], ['system', 'authorize_nonce_account'],
    ['stake', 'authorize'], ['stake', 'delegate_stake'] ,
  ]
  for (const [slug, name] of must) {
    const ix = instructionByName(slug, name)
    assert.ok(ix, `${slug}.${name} exists`)
    if (name === 'delegate_stake') { assert.equal(ix.risk !== 'read_only', true); continue }
    assert.equal(ix.defaultDeny, true, `${slug}.${name}`)
  }
})

test('isDefaultDeny / riskOf tolerate Uint8Array, 0x prefix and bad input', () => {
  assert.equal(isDefaultDeny(TOKEN, new Uint8Array([6, 0, 0, 0, 0, 0, 0, 0])), true) // set_authority = tag 6
  assert.equal(isDefaultDeny(TOKEN, '0x0600000000000000'), true)
  assert.equal(riskOf(TOKEN, 'zz'), null)
  assert.equal(riskOf(TOKEN, '06'), null)
})

test('presets resolve to registry entries and contain no default-deny instruction', () => {
  const all = presets()
  assert.ok(all.length >= 5)
  for (const p of all) {
    for (const perm of p.permissions) for (const ix of perm.instructions) {
      assert.equal(isDefaultDeny(Object.values(perm.programIds)[0], ix.disc8), false, `${p.name}.${ix.name}`)
      assert.equal(ix.disc8, instructionByName(perm.slug, ix.name).disc8)
    }
    for (const b of p.explicitly_blocked ?? []) assert.ok(instructionByName(b.program, b.instruction), `${p.name} blocks ${b.program}.${b.instruction}`)
  }
  const s = preset('dex-trader-single-pool')
  assert.deepEqual(s.permissions[0].instructions.map((i) => i.disc8), ['8fbe5adac41e33de'])
  assert.equal(preset('nope'), null)
})

test('loaded data is frozen', () => {
  assert.throws(() => { 'use strict'; programs[0].slug = 'x' }, TypeError)
})
