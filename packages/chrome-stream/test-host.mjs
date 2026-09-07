// Dependency-injected test host: no extension or access to the user's profile.
// This file is not staged into the shipped application.
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { startBridge } from '../../src-tauri/chrome-stream/server.mjs';
const input = createInterface({ input: process.stdin });
const config = await new Promise(resolve => input.once('line', line => resolve(JSON.parse(line))));
input.close();
await startBridge(config, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  await browser.newContext();
  return browser;
});
