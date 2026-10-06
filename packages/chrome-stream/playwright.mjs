// The sole dependency on Playwright's internal MCP extension API. Keep the
// package exact-pinned and exercise this adapter when upgrading it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { tools } = require('playwright-core/lib/coreBundle');
export const { wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle');

// chrome.debugger cannot attach to the browser target, which the public
// newCDPSession(page) API attempts first. Reuse Playwright's existing tab
// session instead; all commands still cross its extension relay.
export function pageSession(page) {
  const impl = page._connection.toImpl?.(page);
  const session = impl?.delegate?._mainFrameSession?._client;
  if (!session?.send || !session?.on) throw new Error('This Playwright version does not expose the extension page session.');
  return session;
}

export async function connectChrome() {
  const { browser } = await tools.createBrowserWithInfo(
    { extension: true, browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' } } },
    { clientName: 'Canopy', roots: [], timestamp: Date.now() },
    { browser: 'chrome' },
  );
  return browser;
}

// A workspace preview owns its Chromium process/profile. It never connects to
// the viewing computer's Chrome extension or another member's browser profile.
export async function connectWorkspace(profileDirectory){
 const {chromium}=require('playwright-core');
 const context=await chromium.launchPersistentContext(profileDirectory,{executablePath:process.env.CANOPY_CHROMIUM_EXECUTABLE??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],viewport:{width:1280,height:720}});
 return context.browser();
}
