import { render, screen } from '@testing-library/react'
import { BudgetMeter } from '@/components/meter'

describe('BudgetMeter', () => {
  it('shows used, limit and remaining in human units', () => {
    render(<BudgetMeter label="Token budget" used={3_000_000n} limit={20_000_000n} decimals={6} />)
    const meter = screen.getByRole('meter', { name: 'Token budget' })
    expect(meter).toHaveAttribute('aria-valuenow', '15')
    expect(meter).toHaveAttribute('aria-valuetext', '3 of 20 used, 17 left')
  })

  it('never prints a bare 0 for an unlimited budget', () => {
    render(<BudgetMeter label="Token budget" used={0n} limit="unlimited" decimals={6} />)
    expect(screen.getByText(/unlimited/)).toBeInTheDocument()
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', '0 used, no lifetime limit')
  })

  it('caps at 100 percent and reports nothing left when the budget is spent', () => {
    render(<BudgetMeter label="Spent" used={25_000_000n} limit={20_000_000n} decimals={6} />)
    const meter = screen.getByRole('meter')
    expect(meter).toHaveAttribute('aria-valuenow', '100')
    expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining('0 left'))
  })

  it('falls back to raw units when the unit of the slot is unknown', () => {
    render(<BudgetMeter label="Other program" used={2n} limit={10n} decimals={null} />)
    expect(screen.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      '2 raw units of 10 raw units used, 8 raw units left',
    )
  })
})
