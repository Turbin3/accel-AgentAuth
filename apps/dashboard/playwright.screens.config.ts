import { defineConfig } from '@playwright/test'
import base from './playwright.config'

/** Screenshots of every page in light and dark into docs/assets/screens (run after the e2e flows). */
export default defineConfig({ ...base, testMatch: /screens\.shot\.ts/ })
