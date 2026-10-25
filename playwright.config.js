// Playwright config for NEXORA real-browser end-to-end tests.
// The app server is booted by global-setup (tests/browser/serve.mjs, which
// reuses backend/tests/helpers.js startTestServer()); tests read its
// ephemeral baseUrl from tests/browser/.server.json via helpers.mjs.
// Only Chromium is used; the mobile viewport is exercised inside the
// navigation spec with a second context, so the suite does not run twice.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.js',
  globalSetup: './tests/browser/global-setup.mjs',
  globalTeardown: './tests/browser/global-teardown.mjs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'tests/browser/artifacts/html-report', open: 'never' }]],
  use: {
    baseURL: undefined, // tests use the absolute baseUrl from .server.json
    viewport: { width: 1280, height: 720 },
    trace: 'off', // one explicit trace is captured in the delivery spec
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } }],
});
