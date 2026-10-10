import { render, screen, within } from '@testing-library/react'
import { ExplainPreview } from '@/components/explain'
import { explanation } from './fixtures'

describe('ExplainPreview', () => {
  it('renders CAN and CANNOT lists from explainMandate', () => {
    const e = explanation()
    render(<ExplainPreview explanation={e} />)
    expect(screen.getByRole('heading', { name: 'The agent CAN' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'The agent CANNOT' })).toBeInTheDocument()
    const can = screen.getByRole('region', { name: 'The agent CAN' })
    for (const line of e.can) expect(within(can).getByText(line)).toBeInTheDocument()
    expect(e.can.length).toBeGreaterThan(0)
  })

  it('labels relay transfer as hard enforcement', () => {
    render(<ExplainPreview explanation={explanation()} />)
    const enforcement = screen.getByRole('region', { name: 'Enforcement' })
    expect(within(enforcement).getAllByText('hard (relay)').length).toBeGreaterThan(0)
  })

  it('labels everything advisory when there is no relay policy', () => {
    render(<ExplainPreview explanation={explanation({ withPolicy: false })} />)
    expect(screen.queryByText('hard (relay)')).not.toBeInTheDocument()
    expect(screen.getAllByText('advisory').length).toBeGreaterThan(0)
  })

  it('says nothing is allowed right now when the mandate is paused', () => {
    render(<ExplainPreview explanation={explanation({ paused: true })} />)
    expect(screen.getByText('Nothing right now (paused).')).toBeInTheDocument()
  })

  it('marks a wizard preview as not on chain yet', () => {
    render(<ExplainPreview explanation={explanation()} hypothetical />)
    expect(screen.getByText('preview, not on chain yet')).toBeInTheDocument()
  })

  it('shows SDK warnings', () => {
    const e = { ...explanation(), warnings: ['unlimited per-call limit'] }
    render(<ExplainPreview explanation={e} />)
    expect(screen.getByText('unlimited per-call limit')).toBeInTheDocument()
  })
})
