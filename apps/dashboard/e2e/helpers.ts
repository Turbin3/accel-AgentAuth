import { expect, type Page } from '@playwright/test'

/** Connect with the server-side demo owner dev signer (localnet only). */
export async function connectDemoOwner(page: Page): Promise<string> {
  await page.getByTestId('connect-button').click()
  await page.getByTestId('connect-dev-server').click()
  await expect(page.getByTestId('dev-banner')).toBeVisible()
  const address = await page.evaluate(async () => {
    const r = await fetch('/api/dev/signer')
    return ((await r.json()) as { address: string }).address
  })
  return address
}

/** Collect console errors and failed requests so a flow also proves the pages are quiet. */
export function watchConsole(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  return problems
}
