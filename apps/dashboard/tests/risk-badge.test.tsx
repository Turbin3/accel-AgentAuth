import { render, screen } from '@testing-library/react'
import { EnforcementTag, RiskBadge, enforcementLevel } from '@/components/risk'

describe('RiskBadge', () => {
  it.each([
    ['authority_change', 'authority change'],
    ['account_close', 'account close'],
    ['admin', 'admin'],
  ])('marks %s as a red (default-deny) class', (risk, label) => {
    render(<RiskBadge risk={risk} />)
    const chip = screen.getByText(new RegExp(label))
    expect(chip.className).toContain('text-bad')
  })

  it('keeps read-only neutral and warns on value movement', () => {
    const { rerender } = render(<RiskBadge risk="read_only" />)
    expect(screen.getByText('read only').className).not.toContain('text-bad')
    rerender(<RiskBadge risk="value_out" />)
    expect(screen.getByText(/value out/).className).toContain('text-warn')
  })

  it('treats a missing or unknown class as unknown, never as safe', () => {
    const { rerender } = render(<RiskBadge risk={null} />)
    expect(screen.getByText('unknown')).toHaveAttribute(
      'title',
      expect.stringContaining('Treat as dangerous'),
    )
    rerender(<RiskBadge risk="surprise" />)
    expect(screen.getByText('surprise')).toBeInTheDocument()
  })
})

describe('EnforcementTag', () => {
  it('labels hard and advisory differently and says why', () => {
    const { rerender } = render(<EnforcementTag level="hard" />)
    expect(screen.getByText('hard (relay)')).toHaveAttribute(
      'title',
      expect.stringContaining('relay program itself'),
    )
    rerender(<EnforcementTag level="advisory" />)
    expect(screen.getByText('advisory')).toHaveAttribute(
      'title',
      expect.stringContaining('calls verify'),
    )
  })

  it('maps the SDK label to a level', () => {
    expect(enforcementLevel('hard (relay)')).toBe('hard')
    expect(enforcementLevel('advisory (integrator must call verify)')).toBe('advisory')
  })
})
