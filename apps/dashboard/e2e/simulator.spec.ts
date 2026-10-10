import { expect, test } from '@playwright/test'
import { watchConsole } from './helpers'

/**
 * "Try to break it": a SCRIPTED compromised agent against the demo mandate. Each attack lands on
 * chain (preflight skipped) and the page shows the real error, decoded, with the signature.
 */
const CASES: { id: string; error: RegExp; outcome: 'blocked' | 'allowed' }[] = [
  { id: 'legit-payment', error: /^$/, outcome: 'allowed' },
  { id: 'pay-attacker', error: /relay: RecipientNotAllowed \(code 104\)/, outcome: 'blocked' },
  { id: 'over-per-call', error: /agent_auth: PerTxExceeded \(code 8\)/, outcome: 'blocked' },
  {
    id: 'over-lifetime-budget',
    error: /agent_auth: SpendLimitExceeded \(code 9\)/,
    outcome: 'blocked',
  },
  { id: 'set-authority', error: /token: OwnerMismatch \(code 4\)/, outcome: 'blocked' },
  { id: 'wrong-program', error: /agent_auth: ProgramNotAllowed \(code 6\)/, outcome: 'blocked' },
  { id: 'after-pause', error: /relay: Paused \(code 116\)/, outcome: 'blocked' },
  { id: 'after-revoke', error: /relay: InvalidPolicy \(code 101\)/, outcome: 'blocked' },
]

test.describe.serial('simulator', () => {
  test('the page labels the attacker as a script', async ({ page }) => {
    await page.goto('/simulator')
    await expect(page.getByText('This attacker is a script')).toBeVisible()
    await expect(page.getByText('scripted attack').first()).toBeVisible()
    await expect(page.getByText('The simulator uses its own token account')).toBeVisible()
  })

  test('every attack is stopped by a program and decoded', async ({ page }) => {
    test.setTimeout(480_000)
    const problems = watchConsole(page)
    await page.goto('/simulator')
    await expect(page.getByTestId('attack-pay-attacker')).toBeEnabled()
    // Start from a known state: a fresh demo mandate with a zero spend counter.
    await page.getByTestId('sim-reset').click()
    await expect(page.getByTestId('sim-reset')).toHaveText('Reset demo mandate', {
      timeout: 120_000,
    })

    for (const c of CASES) {
      await page.getByTestId(`attack-${c.id}`).click()
      const result = page.locator(`[data-testid="attack-result"][data-attack="${c.id}"]`).first()
      await expect(result).toBeVisible({ timeout: 120_000 })
      await expect(result).toHaveAttribute('data-outcome', c.outcome)
      if (c.outcome === 'blocked') {
        await expect(result.getByTestId('attack-error-title')).toContainText(c.error)
        await expect(result).toContainText('as expected')
      } else {
        await expect(result).toContainText('allowed')
      }
      // Every attempt that reached the chain shows its signature, linked to the explorer.
      await expect(result.getByRole('link').first()).toHaveAttribute(
        'href',
        /explorer\.solana\.com\/tx\//,
      )
    }

    // The attacker never gained anything.
    await expect(page.getByTestId('balance-attacker').first()).toHaveText('0')
    expect(problems).toEqual([])
  })

  test('the blocked attempts appear in the demo mandate activity feed', async ({ page }) => {
    await page.goto('/simulator')
    await page.getByTestId('attack-over-per-call').click()
    await expect(
      page.locator('[data-testid="attack-result"][data-attack="over-per-call"]').first(),
    ).toBeVisible({ timeout: 120_000 })
    await page.getByRole('link', { name: 'Open full detail and activity feed' }).click()
    const blocked = page
      .locator('[data-testid="activity-row"][data-blocked="true"]')
      .filter({ hasText: 'PerTxExceeded' })
    await expect(blocked.first()).toBeVisible({ timeout: 60_000 })
    await expect(blocked.first()).toContainText('agent_auth')
  })
})
