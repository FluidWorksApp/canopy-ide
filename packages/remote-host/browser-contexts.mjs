// Ported from T3 Code (MIT) apps/server/src/preview/ServerBrowserContexts.ts
// (pingdotgg/t3code d5290e9): the Chromium profile lock.
//
// Chromium refuses a second process on one user-data-dir (its SingletonLock),
// so there is exactly one persistent context per profile directory, cached as
// a promise keyed by profile. Clearing a profile closes its cached context and
// only then removes the directory; a contextFor during the clear waits for it.
// close() is idempotent and rejects later work.
//
// Ported: contextFor, the persistent createContext path, profileDirectory's
// encoding, clearProfile, close/dispose.
// Not ported, because Canopy has one persistent agent profile per workspace
// and no incognito or per-agent isolated tabs: the shared non-persistent
// browser (sharedBrowser/sharedContext/retireWhenIdle/scratchPage), the
// launcher/diagnose hooks, presentAsChrome, and connectDesktopPage (desktop
// CDP relay).
// Differences: launch options come from Canopy's own `launch(directory)`
// (its executablePath and args, see agent-browser.mjs) instead of T3's
// launchOptions(); the profile directory is created with mode 0o700 as
// Canopy did before.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const constVoid = () => undefined;

export class BrowserContexts {
  /**
   * @param {{
   *   profilesDir: string,
   *   launch: (directory: string) => Promise<import('playwright-core').BrowserContext>,
   *   onContextClose?: (context: import('playwright-core').BrowserContext) => void,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.contexts = new Map();
    this.clearing = new Map();
    this.closing = undefined;
  }

  contextFor(profileId) {
    if (this.closing) return Promise.reject(new Error('The preview browser is closed.'));
    // T3 keys by [profileId, isolationKey]; Canopy never isolates, so it is always null.
    const key = JSON.stringify([profileId, null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId))
      .then(async context => {
        context.on('close', () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error('The preview browser is closed.');
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  async createContext(profileId) {
    const directory = this.profileDirectory(profileId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return this.options.launch(directory);
  }

  profileDirectory(profileId) {
    const encoded = encodeURIComponent(profileId);
    return join(
      this.options.profilesDir,
      profileId === '.' || profileId === '..' ? encoded.replaceAll('.', '%2E') : encoded,
    );
  }

  /** Closes a profile's Chromium and keeps its directory (the desktop host's idle profiles). */
  async closeProfile(profileId) {
    const key = JSON.stringify([profileId, null]);
    const pending = this.contexts.get(key);
    if (!pending) return;
    this.contexts.delete(key);
    const context = await pending.catch(() => undefined);
    await context?.close().catch(constVoid);
  }

  async clearProfile(profileId) {
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async pending => (await pending).close()),
    );
    this.contexts.clear();
  }
}
