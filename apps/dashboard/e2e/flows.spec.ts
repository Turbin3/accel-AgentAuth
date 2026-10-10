import { expect, test, type Page } from '@playwright/test'
import { connectDemoOwner, watchConsole } from './helpers'

/**
 * The full owner journey on a fresh local validator with the demo bootstrapped, signed by the dev
 * signer: wizard -> list -> pause/resume -> per-instruction revoke -> unwind. Serial: each test
 * builds on the chain state the previous one left.
 */
test.describe.serial('owner journey', () => {
  let mandatePath = ''
  let agent = ''
  let page: Page
  let problems: string[]

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    problems = watchConsole(page)
  })
  test.afterAll(async () => {
    await page.close()
  })

  test('create a mandate through the wizard', async () => {
    await page.goto('/mandates/new')
    await connectDemoOwner(page)

    await page.getByRole('button', { name: 'Generate a demo agent' }).click()
    agent = await page.locator('#agent').inputValue()
    expect(agent).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

    await page.getByLabel('USDC payments').check()
    // Accounts are sorted by balance: the funded demo DUSD account comes first.
    const sourceValue = await page.locator('#source option').nth(1).getAttribute('value')
    await page.locator('#source').selectOption(sourceValue ?? '')
    // A leftover delegation from an earlier run on the same chain needs an explicit yes.
    const replace = page.getByLabel('Replace the existing delegate')
    if (await replace.count()) await replace.check()
    await page.getByLabel('Cap per call').fill('5')
    await page.getByLabel('Total budget').fill('20')
    await page.getByLabel('Lasts for').fill('24h')
    await page.getByRole('button', { name: 'Use the demo recipient (Alice)' }).click()

    // Live plain-English preview straight from explainMandate.
    const preview = page.getByTestId('explain-preview')
    await expect(preview).toContainText('The agent CAN')
    await expect(preview).toContainText('The agent CANNOT')
    await expect(page.getByText('hard (relay)').first()).toBeVisible()
    await expect(page.getByTestId('plan-preview')).toContainText('2 to sign')

    await page.getByTestId('sign-and-send').click()
    const steps = page.getByTestId('tx-step')
    await expect(steps).toHaveCount(2)
    await expect(steps.nth(0)).toHaveAttribute('data-status', 'done')
    await expect(steps.nth(1)).toHaveAttribute('data-status', 'done')

    const open = page.getByTestId('open-created')
    await expect(open).toBeVisible()
    mandatePath = (await open.getAttribute('href')) ?? ''
    expect(mandatePath).toMatch(/^\/mandates\/[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  })

  test('the new mandate is listed with status and budget', async () => {
    await page.goto('/mandates')
    const card = page.getByTestId('mandate-card').filter({ hasText: agent.slice(0, 4) })
    await expect(card).toBeVisible()
    await expect(card).toContainText('active')
    await expect(card.getByRole('meter')).toHaveAttribute('aria-valuetext', /0 of 20/)
    await card.getByRole('link', { name: 'Open mandate' }).click()
    await expect(page).toHaveURL(new RegExp(`${mandatePath}$`))
  })

  test('detail page: permissions, risk and activity feed', async () => {
    await page.goto(mandatePath)
    await expect(page.getByRole('heading', { name: 'Mandate', exact: true })).toBeVisible()
    await expect(page.getByTestId('status-chips')).toContainText('active')
    await expect(page.getByTestId('status-chips')).toContainText('relay live')
    const instruction = page.getByTestId('permission-instruction')
    await expect(instruction).toHaveCount(1)
    await expect(instruction).toContainText('Transfer (checked)')
    await expect(instruction).toContainText('hard (relay)')
    await expect(page.getByTestId('max-spend')).toHaveText('5')
    // Creating the mandate is on chain history: the feed shows it.
    await expect(page.getByTestId('activity-row').first()).toBeVisible()
    await expect(
      page.getByTestId('activity-row').filter({ hasText: 'Mandate created' }),
    ).toHaveCount(1)
  })

  test('pause the relay only, then resume', async () => {
    await page.goto(mandatePath)
    await page.getByTestId('pause-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('The relay will refuse every payment and swap')
    await expect(page.getByTestId('will-send')).toContainText('set_paused')
    await page.getByTestId('confirm-action').click()
    await expect(page.getByTestId('tx-step').first()).toHaveAttribute('data-status', 'done')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('status-chips')).toContainText('relay paused')
    await expect(page.getByTestId('max-spend')).toHaveCount(0) // blocked: capacity shows the reason instead

    await page.getByTestId('resume-button').click()
    await page.getByTestId('confirm-action').click()
    await expect(page.getByTestId('tx-step').first()).toHaveAttribute('data-status', 'done')
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('status-chips')).toContainText('relay live')
  })

  test('revoke one instruction live', async () => {
    await page.goto(mandatePath)
    await page.getByTestId('revoke-instruction').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('The agent loses the right to call')
    await expect(page.getByTestId('will-send')).toContainText('remove_permission')
    await page.getByTestId('confirm-action').click()
    await expect(page.getByTestId('tx-step').first()).toHaveAttribute('data-status', 'done')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByTestId('permission-instruction')).toHaveCount(0)
    await expect(page.getByText('this mandate has no permissions', { exact: false })).toBeVisible()
  })

  test('unwind: revoke everything in one transaction', async () => {
    await page.goto(mandatePath)
    await page.getByTestId('unwind-button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('This does not undo past transfers')
    const will = page.getByTestId('will-send')
    await expect(will).toContainText('revoke_mandate')
    await expect(will).toContainText('close_policy')
    await expect(will).toContainText('Revoke')
    await expect(dialog).toContainText('1 transaction')
    await page.getByTestId('confirm-action').click()
    await expect(page.getByTestId('tx-step').first()).toHaveAttribute('data-status', 'done')
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('No mandate at this address')).toBeVisible()
  })

  test('no console errors during the journey', () => {
    expect(problems).toEqual([])
  })
})
