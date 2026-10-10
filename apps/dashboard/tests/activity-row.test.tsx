import { render, screen } from '@testing-library/react'
import { errorFromCode, type ActivityItem, type AgentAuthError } from '@agentauth-sol/sdk'
import { ActivityRow } from '@/components/activity-row'
import { ConfigProvider } from '@/lib/config-context'
import { RECIPIENT, TEST_CONFIG } from './fixtures'

const SIG =
  '5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7'

function row(over: Partial<ActivityItem>): ActivityItem {
  return {
    signature: SIG,
    slot: 100n,
    blockTime: 1_700_000_000n,
    kind: 'relay_transfer',
    ok: true,
    instructionIndex: 0,
    ...over,
  }
}

function renderRow(item: ActivityItem, labels: Record<string, string> = {}, symbol?: string) {
  return render(
    <ConfigProvider config={TEST_CONFIG}>
      <ul>
        <ActivityRow
          item={item}
          decimals={6}
          {...(symbol ? { symbol } : {})}
          labels={labels}
          nowSeconds={1_700_000_030}
        />
      </ul>
    </ConfigProvider>,
  )
}

describe('ActivityRow', () => {
  it('shows an allowed payment with human amount and the recipient label', () => {
    renderRow(row({ amount: 3_000_000n, recipient: RECIPIENT }), { [RECIPIENT]: 'Alice' })
    expect(screen.getByTestId('activity-row')).toHaveAttribute('data-blocked', 'false')
    expect(screen.getByText(/allowed/)).toBeInTheDocument()
    expect(screen.getByText('Relay payment')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('shows the token symbol after the amount', () => {
    renderRow(row({ amount: 3_000_000n, recipient: RECIPIENT }), {}, 'DUSD')
    expect(screen.getByTestId('activity-row')).toHaveTextContent('Amount 3 DUSD')
  })

  it('shows a blocked attempt with the decoded program, name and code', () => {
    const error: AgentAuthError = errorFromCode('relay', 104)
    renderRow(row({ ok: false, amount: 40_000_000n, recipient: RECIPIENT, error }))
    expect(screen.getByTestId('activity-row')).toHaveAttribute('data-blocked', 'true')
    expect(screen.getByText(/blocked/)).toBeInTheDocument()
    const box = screen.getByTestId('activity-error')
    expect(box).toHaveTextContent('relay: RecipientNotAllowed')
    expect(box).toHaveTextContent('code 104')
    expect(box).toHaveTextContent(error.message)
  })

  it('links the signature to the explorer for the configured cluster', () => {
    renderRow(row({}))
    const link = screen.getByRole('link', { name: /opens the explorer/ })
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining(`explorer.solana.com/tx/${SIG}?cluster=custom`),
    )
  })

  it('does not pretend a failed fetch is a normal row', () => {
    renderRow(row({ kind: 'unknown', fetchError: 'rate limited' }))
    expect(screen.getByText(/Could not decode this transaction: rate limited/)).toBeInTheDocument()
  })

  it('says so when a failure carries no program error code', () => {
    renderRow(row({ ok: false }))
    expect(screen.getByText(/no program error code/)).toBeInTheDocument()
  })
})
