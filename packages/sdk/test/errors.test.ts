import { describe, expect, it } from 'vitest'
import {
  AGENT_AUTH_ERRORS,
  AGENT_AUTH_PROGRAM_ID,
  AgentAuthError,
  MOCK_AMM_PROGRAM_ID,
  RELAY_ERRORS,
  RELAY_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_ERRORS,
  TOKEN_PROGRAM_ID,
  errorFromCode,
  lookupError,
  parseProgramError,
} from '../src/index'
import { readIdl } from './helpers'

const coreIdl = readIdl('core-idl')
const relayIdl = readIdl('relay-idl')

const failLine = (program: string, code: number): string =>
  `Program ${program} failed: custom program error: 0x${code.toString(16)}`

describe('error tables are generated against the IDLs', () => {
  it.each(coreIdl.errors as { code: number; name: string }[])(
    'core $code $name',
    ({ code, name }) => {
      const spec = lookupError('agent_auth', code)
      expect(spec?.name).toBe(name)
      const err = parseProgramError([
        `Program ${AGENT_AUTH_PROGRAM_ID} invoke [1]`,
        failLine(AGENT_AUTH_PROGRAM_ID, code),
      ])
      expect(err).toBeInstanceOf(AgentAuthError)
      expect(err).toMatchObject({ program: 'agent_auth', code, name })
      expect(err?.hint.length).toBeGreaterThan(10)
      expect(err?.message.length).toBeGreaterThan(10)
    },
  )

  it.each(relayIdl.errors as { code: number; name: string }[])(
    'relay $code $name',
    ({ code, name }) => {
      expect(lookupError('relay', code)?.name).toBe(name)
      const err = parseProgramError([failLine(RELAY_PROGRAM_ID, code)])
      expect(err).toMatchObject({ program: 'relay', code, name })
    },
  )

  it.each(relayIdl.externalErrors.spl_token as { code: number; name: string }[])(
    'token $code $name',
    ({ code, name }) => {
      expect(lookupError('token', code)?.name).toBe(name)
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        expect(parseProgramError([failLine(programId, code)])).toMatchObject({
          program: 'token',
          code,
          name,
        })
      }
    },
  )

  it('the tables contain exactly the IDL codes (no stale entries)', () => {
    expect(AGENT_AUTH_ERRORS.map((e) => e.code)).toEqual(
      coreIdl.errors.map((e: { code: number }) => e.code),
    )
    expect(RELAY_ERRORS.map((e) => e.code)).toEqual(
      relayIdl.errors.map((e: { code: number }) => e.code),
    )
    expect(AGENT_AUTH_ERRORS.map((e) => e.code)).toEqual(
      Array.from({ length: 22 }, (_, i) => i + 1),
    )
    expect(RELAY_ERRORS.map((e) => e.code)).toEqual(Array.from({ length: 20 }, (_, i) => i + 100))
    for (const e of [...AGENT_AUTH_ERRORS, ...RELAY_ERRORS, ...TOKEN_ERRORS]) {
      expect(e.hint.length).toBeGreaterThan(5)
      expect(typeof e.retryable).toBe('boolean')
    }
  })

  it('relay IDL core error mirror equals the core IDL for codes 1..18', () => {
    for (const e of relayIdl.externalErrors.agent_auth as { code: number; name: string }[]) {
      expect(coreIdl.errors.find((c: { code: number }) => c.code === e.code).name).toBe(e.name)
    }
  })

  it('every relay IDL instruction error code exists in the table', () => {
    for (const ix of relayIdl.instructions as { errors: number[] }[]) {
      for (const code of ix.errors) expect(lookupError('relay', code)).toBeDefined()
    }
  })
})

describe('overlapping codes are resolved by the failing program id', () => {
  const overlaps = [1, 3, 4, 9, 12, 17, 18]
  it.each(overlaps)('code %i means different things in AgentAuth and Token', (code) => {
    const a = parseProgramError([failLine(AGENT_AUTH_PROGRAM_ID, code)])
    const t = parseProgramError([failLine(TOKEN_PROGRAM_ID, code)])
    expect(a?.program).toBe('agent_auth')
    expect(t?.program).toBe('token')
    expect(a?.name).not.toBe(t?.name)
  })

  it('NotActive (AgentAuth 4) vs OwnerMismatch (Token 4)', () => {
    expect(parseProgramError([failLine(AGENT_AUTH_PROGRAM_ID, 4)])?.name).toBe('NotActive')
    expect(parseProgramError([failLine(TOKEN_PROGRAM_ID, 4)])?.name).toBe('OwnerMismatch')
  })

  it('a relay call that fails inside verify is attributed to AgentAuth (origin frame), not to the relay row with the same number', () => {
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${AGENT_AUTH_PROGRAM_ID} invoke [2]`,
      failLine(AGENT_AUTH_PROGRAM_ID, 9),
      failLine(RELAY_PROGRAM_ID, 9),
    ]
    const err = parseProgramError(logs)
    expect(err).toMatchObject({
      program: 'agent_auth',
      code: 9,
      name: 'SpendLimitExceeded',
      programId: AGENT_AUTH_PROGRAM_ID,
    })
  })

  it('a relay call that fails inside the Token CPI is attributed to the Token program', () => {
    const logs = [
      `Program ${RELAY_PROGRAM_ID} invoke [1]`,
      `Program ${TOKEN_PROGRAM_ID} invoke [2]`,
      failLine(TOKEN_PROGRAM_ID, 1),
      failLine(RELAY_PROGRAM_ID, 1),
    ]
    expect(parseProgramError(logs)).toMatchObject({ program: 'token', name: 'InsufficientFunds' })
  })

  it('a relay-native error stays a relay error', () => {
    const logs = [`Program ${RELAY_PROGRAM_ID} invoke [1]`, failLine(RELAY_PROGRAM_ID, 104)]
    expect(parseProgramError(logs)).toMatchObject({
      program: 'relay',
      name: 'RecipientNotAllowed',
      retryable: false,
    })
  })

  it('system program and mock AMM codes', () => {
    expect(parseProgramError([failLine(SYSTEM_PROGRAM_ID, 0)])).toMatchObject({
      program: 'system',
      name: 'AccountAlreadyInUse',
    })
    expect(parseProgramError([failLine(MOCK_AMM_PROGRAM_ID, 7001)])).toMatchObject({
      program: 'mock_amm',
      name: 'ExceededSlippage',
    })
  })

  it('program-id overrides (localnet) are honoured', () => {
    const local = 'LocaL1111111111111111111111111111111111111'
    expect(
      parseProgramError([failLine(local, 5)], { programIds: { agentAuth: local as never } }),
    ).toMatchObject({ program: 'agent_auth', name: 'Expired' })
    expect(parseProgramError([failLine(local, 5)])).toMatchObject({ program: 'unknown' })
  })

  it('unknown program id => unknown, never a guess', () => {
    const err = parseProgramError([failLine('Foo1111111111111111111111111111111111111111', 4)])
    expect(err?.program).toBe('unknown')
    expect(err?.name).toBe('Custom4')
    expect(err?.retryable).toBe(false)
  })

  it('unknown code of a known program', () => {
    expect(parseProgramError([failLine(AGENT_AUTH_PROGRAM_ID, 77)])).toMatchObject({
      program: 'agent_auth',
      code: 77,
      name: 'Custom77',
    })
  })
})

describe('inputs other than a plain log array', () => {
  it('simulation / RPC result objects with logs', () => {
    expect(
      parseProgramError({
        value: {
          err: { InstructionError: [1, { Custom: 6 }] },
          logs: [failLine(AGENT_AUTH_PROGRAM_ID, 6)],
        },
      }),
    ).toMatchObject({ program: 'agent_auth', name: 'ProgramNotAllowed' })
    expect(
      parseProgramError({ meta: { logMessages: [failLine(AGENT_AUTH_PROGRAM_ID, 7)] } }),
    ).toMatchObject({ name: 'DiscriminatorNotAllowed' })
  })
  it('a multi-line string and an Error with a cause', () => {
    const text = `Program log: hi\n${failLine(AGENT_AUTH_PROGRAM_ID, 8)}`
    expect(parseProgramError(text)?.name).toBe('PerTxExceeded')
    expect(
      parseProgramError(new Error('boom', { cause: { logs: [failLine(RELAY_PROGRAM_ID, 116)] } }))
        ?.name,
    ).toBe('Paused')
  })
  it('without logs only the relay range is unambiguous', () => {
    expect(parseProgramError({ InstructionError: [0, { Custom: 116 }] })).toMatchObject({
      program: 'relay',
      name: 'Paused',
    })
    const amb = parseProgramError({ InstructionError: [0, { Custom: 9 }] })
    expect(amb?.program).toBe('unknown')
    expect(amb?.message).toMatch(/agent_auth:SpendLimitExceeded/)
    expect(amb?.message).toMatch(/token:/)
  })
  it('Kit instruction-error context', () => {
    expect(parseProgramError({ context: { code: 118, index: 0 } })).toMatchObject({
      program: 'relay',
      name: 'StalePolicy',
    })
  })
  it('null for everything that carries no custom error', () => {
    expect(parseProgramError(null)).toBeNull()
    expect(parseProgramError(undefined)).toBeNull()
    expect(parseProgramError([])).toBeNull()
    expect(parseProgramError(['Program log: all good'])).toBeNull()
    expect(parseProgramError({ InstructionError: [0, 'SomethingExotic'] })).toBeNull()
    expect(parseProgramError(42)).toBeNull()
  })
})

describe('AgentAuthError shape', () => {
  it('carries program, code, name, message, hint, retryable, logs', () => {
    const logs = [failLine(AGENT_AUTH_PROGRAM_ID, 8)]
    const err = parseProgramError(logs)!
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PerTxExceeded')
    expect(err.retryable).toBe(true)
    expect(err.logs).toEqual(logs)
    expect(err.describe()).toMatch(/^agent_auth:8 PerTxExceeded/)
  })
  it('retryable is true only for errors the agent can fix itself', () => {
    const retryable = [...AGENT_AUTH_ERRORS, ...RELAY_ERRORS]
      .filter((e) => e.retryable)
      .map((e) => e.name)
    expect(retryable.sort()).toEqual(['DeadlineExpired', 'PerTxExceeded', 'SlippageFloorViolated'])
  })
  it('errorFromCode builds the same object for pre-flight failures', () => {
    expect(errorFromCode('relay', 116)).toMatchObject({ program: 'relay', name: 'Paused' })
  })
})
