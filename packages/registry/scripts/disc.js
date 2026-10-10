#!/usr/bin/env node
// Tiny helper so every registry author computes discriminators the same way.
//   node scripts/disc.js anchor swap_base_input      -> sha256("global:swap_base_input")[0..8] (hex)
//   node scripts/disc.js anchor-account Mandate      -> sha256("account:Mandate")[0..8]
//   node scripts/disc.js u8 12                       -> canonical disc8 for a 1-byte tag (0c00000000000000)
//   node scripts/disc.js u32le 2                     -> canonical disc8 for a u32 LE tag (0200000000000000)
import { createHash } from 'node:crypto'

export function anchorDisc(name, ns = 'global') {
  return createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8).toString('hex')
}
export function u8Disc(tag) {
  const b = Buffer.alloc(8); b.writeUInt8(tag, 0); return b.toString('hex')
}
export function u32leDisc(tag) {
  const b = Buffer.alloc(8); b.writeUInt32LE(tag, 0); return b.toString('hex')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, arg] = process.argv.slice(2)
  if (kind === 'anchor') console.log(anchorDisc(arg))
  else if (kind === 'anchor-account') console.log(anchorDisc(arg, 'account'))
  else if (kind === 'u8') console.log(u8Disc(Number(arg)))
  else if (kind === 'u32le') console.log(u32leDisc(Number(arg)))
  else { console.error('usage: disc.js anchor|anchor-account|u8|u32le <arg>'); process.exit(2) }
}
