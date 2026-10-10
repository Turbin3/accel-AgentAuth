import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { connectDemoOwner } from './helpers'

/**
 * Screenshots of every page in light and dark, used by the README and the pitch. Run after the
 * e2e flows so the demo mandate has real history:
 *   pnpm --filter @agentauth-sol/dashboard screens
 */
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'assets',
  'screens',
)
mkdirSync(OUT, { recursive: true })

async function shot(page: Page, name: string, theme: 'light' | 'dark') {
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: join(OUT, `${name}-${theme}.png`), fullPage: true })
}

for (const theme of ['light', 'dark'] as const) {
  test(`screens (${theme})`, async ({ browser }) => {
    test.setTimeout(300_000)
    const context = await browser.newContext({
      colorScheme: theme,
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()

    await page.goto('/')
    await expect(page.getByTestId('program-row').first()).toBeVisible()
    await expect(page.getByText('deployed').first()).toBeVisible()
    await shot(page, '01-landing', theme)

    await connectDemoOwner(page)
    await page.goto('/mandates')
    await expect(page.getByTestId('mandate-card').first()).toBeVisible()
    await shot(page, '02-mandates', theme)

    // Wizard, filled in up to the live preview (nothing is signed).
    await page.goto('/mandates/new')
    await page.getByRole('button', { name: 'Generate a demo agent' }).click()
    await page.getByLabel('USDC payments').check()
    const value = await page.locator('#source option').nth(1).getAttribute('value')
    await page.locator('#source').selectOption(value ?? '')
    const replace = page.getByLabel('Replace the existing delegate')
    if (await replace.count()) await replace.check()
    await page.getByLabel('Cap per call').fill('5')
    await page.getByLabel('Total budget').fill('20')
    await page.getByLabel('Lasts for').fill('24h')
    await page.getByRole('button', { name: 'Use the demo recipient (Alice)' }).click()
    await expect(page.getByTestId('explain-preview')).toBeVisible()
    await shot(page, '03-wizard', theme)

    // Simulator with two real results, then the detail page of the demo mandate it attacked.
    await page.goto('/simulator')
    await expect(page.getByTestId('attack-pay-attacker')).toBeEnabled()
    await page.getByTestId('attack-pay-attacker').click()
    await expect(page.locator('[data-testid="attack-result"]').first()).toBeVisible({
      timeout: 120_000,
    })
    await page.getByTestId('attack-over-per-call').click()
    await expect(
      page.locator('[data-testid="attack-result"][data-attack="over-per-call"]'),
    ).toBeVisible({ timeout: 120_000 })
    await shot(page, '05-simulator', theme)

    await page.getByRole('link', { name: 'Open full detail and activity feed' }).click()
    await expect(
      page.locator('[data-testid="activity-row"][data-blocked="true"]').first(),
    ).toBeVisible({ timeout: 60_000 })
    await shot(page, '04-mandate-detail', theme)

    await page.goto('/registry')
    await expect(page.getByTestId('registry-count')).toBeVisible()
    await shot(page, '06-registry', theme)

    await page.goto('/docs')
    await shot(page, '07-docs', theme)

    // Phone width, to prove the layout holds at 360px.
    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto('/')
    await shot(page, '08-landing-360', theme)
    await page.goto('/mandates')
    await expect(page.getByTestId('mandate-card').first()).toBeVisible()
    await shot(page, '09-mandates-360', theme)

    await context.close()
  })
}
