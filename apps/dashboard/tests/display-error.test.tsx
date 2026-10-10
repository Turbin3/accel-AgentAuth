import { render, screen } from '@testing-library/react'
import { errorFromCode, SdkError, ValidationError } from '@agentauth-sol/sdk'
import { ErrorBox } from '@/components/ui'
import { toDisplayError } from '@/lib/tx-runner'

describe('toDisplayError network failures', () => {
  it('maps a failed fetch to a cannot-reach-the-RPC message when an RPC url is given', () => {
    const d = toDisplayError(new TypeError('Failed to fetch'), 'http://127.0.0.1:8899')
    expect(d.title).toBe('Cannot reach the RPC at http://127.0.0.1:8899')
    const nested = new Error('rpc failed', { cause: new TypeError('fetch failed') })
    expect(toDisplayError(nested, 'http://x').title).toContain('Cannot reach the RPC at http://x')
    expect(toDisplayError(new TypeError('Failed to fetch')).title).toBe('TypeError')
  })
})

describe('toDisplayError', () => {
  it('turns a decoded program error into title, detail, hint and a program-qualified code', () => {
    const d = toDisplayError(errorFromCode('agent_auth', 8))
    expect(d.title).toBe('agent_auth: PerTxExceeded')
    expect(d.code).toBe('agent_auth:8')
    expect(d.hint).toBeTruthy()
  })

  it('decodes a raw transaction error from logs when it can', () => {
    const logs = [
      'Program 33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6 invoke [1]',
      'Program 33VpeDjreoanKn8Qa5HLLF247W1ctwgMnixg36yhqkN6 failed: custom program error: 0x68',
    ]
    expect(toDisplayError({ err: { InstructionError: [0, { Custom: 104 }] }, logs }).title).toBe(
      'relay: RecipientNotAllowed',
    )
  })

  it('keeps SDK client-side errors readable', () => {
    const d = toDisplayError(new ValidationError('BAD_UNITS', 'not a number'))
    expect(d.detail).toContain('not a number')
    expect(toDisplayError(new SdkError('TX_TIMEOUT', 'slow')).title).toBe('TX_TIMEOUT')
  })

  it('handles non-errors', () => {
    expect(toDisplayError('boom')).toEqual({ title: 'Error', detail: 'boom' })
  })
})

describe('ErrorBox', () => {
  it('is announced as an alert with the hint spelled out', () => {
    render(<ErrorBox error={toDisplayError(errorFromCode('relay', 116))} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('relay: Paused')
    expect(alert).toHaveTextContent('What to do')
  })

  it('renders nothing for no error', () => {
    const { container } = render(<ErrorBox error={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
