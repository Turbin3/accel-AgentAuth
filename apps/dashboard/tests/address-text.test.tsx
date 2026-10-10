import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddressText } from '@/components/address'
import { ConfigProvider } from '@/lib/config-context'
import { OWNER, TEST_CONFIG } from './fixtures'

describe('AddressText', () => {
  it('shows a middle-ellipsis monospace address with the full value as tooltip', () => {
    render(
      <ConfigProvider config={TEST_CONFIG}>
        <AddressText value={OWNER} />
      </ConfigProvider>,
    )
    const text = screen.getByText('4Nd1...qy5z')
    expect(text).toHaveAttribute('title', OWNER)
    expect(text.className).toContain('font-mono')
  })

  it('copies the full address and confirms for assistive tech', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(
      <ConfigProvider config={TEST_CONFIG}>
        <AddressText value={OWNER} label="Owner" />
      </ConfigProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Copy address/ }))
    expect(writeText).toHaveBeenCalledWith(OWNER)
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/ })).toBeInTheDocument())
    expect(screen.getByText('Owner')).toBeInTheDocument()
  })

  it('links to the explorer for the configured cluster when asked', () => {
    render(
      <ConfigProvider config={TEST_CONFIG}>
        <AddressText value={OWNER} link />
      </ConfigProvider>,
    )
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining(`/address/${OWNER}?cluster=custom`),
    )
  })
})
