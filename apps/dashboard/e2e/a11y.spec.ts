import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { connectDemoOwner } from './helpers'

/** axe-core on every page in both themes, plus the open dialogs. Serious and critical issues fail. */
async function audit(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  // Guard against a silently empty audit: axe must actually have evaluated rules.
  expect(results.passes.length, `${label}: axe evaluated no rules`).toBeGreaterThan(15)
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  )
  const summary = blocking.map(
    (v) =>
      `${label}: ${v.id} (${v.impact}) ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  )
  expect(summary).toEqual([])
  // Moderate and minor findings are reported but do not fail the build.
  const rest = results.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical')
  expect(rest.map((v) => `${label}: ${v.id} (${v.impact})`)).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.use({ colorScheme: scheme })

    test('public pages', async ({ page }) => {
      for (const path of ['/', '/mandates', '/mandates/new', '/simulator', '/registry', '/docs']) {
        await page.goto(path)
        await page.waitForLoadState('networkidle')
        await audit(page, `${scheme} ${path}`)
      }
    })

    test('connected pages, dialogs and the detail page', async ({ page }) => {
      // A fresh chain has no mandate to audit: make sure the demo mandate exists (idempotent).
      const reset = await page.request.post('/api/simulator', { data: { action: 'reset' } })
      expect(reset.ok()).toBe(true)
      await page.goto('/')
      await connectDemoOwner(page)
      await page.goto('/mandates')
      const card = page.getByTestId('mandate-card').first()
      await expect(card).toBeVisible()
      await audit(page, `${scheme} /mandates (connected)`)
      await page.goto('/mandates/new')
      await page.getByRole('button', { name: 'Generate a demo agent' }).click()
      await expect(page.locator('#source option').nth(1)).toBeAttached()
      await audit(page, `${scheme} /mandates/new (connected)`)
      await page.goto('/mandates')
      await card.getByRole('link', { name: 'Open mandate' }).click()
      await expect(page.getByRole('heading', { name: 'Mandate', exact: true })).toBeVisible()
      await expect(page.getByTestId('activity-row').first()).toBeVisible({ timeout: 60_000 })
      await audit(page, `${scheme} mandate detail`)
      await page.getByTestId('unwind-button').click()
      await expect(page.getByTestId('will-send')).toBeVisible()
      await audit(page, `${scheme} unwind dialog`)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    })
  })
}
