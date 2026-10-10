import { expect, test } from '@playwright/test'
import { watchConsole } from './helpers'

const PAGES = ['/', '/mandates', '/mandates/new', '/simulator', '/registry', '/docs']

for (const path of PAGES) {
  test(`page ${path} renders without console errors`, async ({ page }) => {
    const problems = watchConsole(page)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('note').first()).toContainText('Unaudited devnet prototype')
    await page.waitForLoadState('networkidle')
    expect(problems).toEqual([])
  })
}
