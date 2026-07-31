// Agent notifications, delivered to the device you are actually holding.
//
// The source is already on the wire: `agent:event` is forwarded to every remote
// socket (FORWARDED_EVENTS in portal.rs), and `derivePending` in
// shared/notifications.ts turns that stream into the same cards the desktop's
// Agents panel shows. This file is the last hop — turning a card the phone has
// never seen into an OS notification.
//
// Two things are deliberately not hidden from the user:
//
//  1. **A plain-HTTP LAN link cannot do this.** The Notification API and service
//     workers are secure-context only, so `http://192.168.x.x:6680` has neither,
//     however many times you tap "Enable". The UI says so and points at the
//     tunnel rather than showing a button that does nothing.
//  2. **This delivers while the page is loaded** — foreground or backgrounded,
//     which covers "my phone is in my pocket and the tab is still open". Waking
//     a phone with the browser fully closed needs the Push API and a VAPID key
//     pair on the desktop, which is a separate build; it is not implied here.

import type { PendingItem } from '@shared/notifications'
import { agentMeta } from '@shared/model'

const ENABLED_KEY = 'canopy-remote-notify'
/** Where the portal is served from — the service worker's scope, and what a
 *  notification click focuses. */
const SCOPE = '/remote/'

export type NotifyState =
  | 'unsupported' // no Notification API at all (old browser)
  | 'insecure' // plain HTTP: the API exists on paper but is gated off
  | 'default' // supported, never asked
  | 'granted'
  | 'denied'

export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined') {
    // On an insecure origin some browsers hide the constructor entirely, so
    // check the context first — "not supported" would be the wrong advice.
    return typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'unsupported'
  }
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure'
  return Notification.permission as NotifyState
}

export function wantsNotifications(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== 'off'
}

export function setWantsNotifications(on: boolean): void {
  localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off')
}

/** Ask the browser. Must be called from a real user gesture — every mobile
 *  browser refuses a prompt raised on page load, which is why this is a button
 *  in the UI and not something the shell does for you. */
export async function requestNotifications(): Promise<NotifyState> {
  if (notifyState() !== 'default') return notifyState()
  const result = await Notification.requestPermission()
  if (result === 'granted') {
    setWantsNotifications(true)
    void registerWorker()
  }
  return result as NotifyState
}

let workerReg: ServiceWorkerRegistration | null = null

/** A service worker is what lets a notification survive the tab being
 *  backgrounded on Android, and it owns the click that brings the tab back. No
 *  worker (iOS outside a PWA, an insecure origin) just means the direct
 *  constructor, which still works while the page is in the foreground. */
export async function registerWorker(): Promise<void> {
  if (workerReg || !('serviceWorker' in navigator)) return
  try {
    workerReg = await navigator.serviceWorker.register(`${SCOPE}sw.js`, { scope: SCOPE })
  } catch {
    workerReg = null
  }
}

export interface Alert {
  key: string
  title: string
  body: string
  /** The agent's live PTY, so a tap lands on its terminal rather than home. */
  pty: number | null
  urgent: boolean
}

/** What a pending card says when it has to fit on a lock screen. */
export function alertFor(item: PendingItem): Alert {
  const label = agentMeta(item.agent).label
  const where = item.cwd.split('/').filter(Boolean).pop() ?? ''
  const title =
    item.kind === 'question'
      ? `${label} is asking you something`
      : item.kind === 'notification'
        ? `${label} needs you`
        : `${label} finished`
  const body =
    item.questions?.[0]?.question ??
    item.message ??
    (item.kind === 'idle' ? 'Waiting for your next instruction.' : 'Waiting on you.')
  return {
    key: item.key,
    title: where ? `${title} · ${where}` : title,
    body: body.slice(0, 180),
    pty: item.pty,
    urgent: item.kind !== 'idle',
  }
}

/**
 * Show one alert. Idle notices are `silent` and renotify-free: an agent
 * finishing is worth a line on the lock screen, not a buzz in your pocket, and
 * conflating the two is how a notification channel gets muted for good.
 */
export async function showAlert(alert: Alert): Promise<void> {
  if (notifyState() !== 'granted' || !wantsNotifications()) return
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: alert.body,
    // One notification per session-event, so a re-derived card replaces its
    // predecessor instead of stacking a second copy of the same question.
    tag: alert.key,
    silent: !alert.urgent,
    requireInteraction: false,
    data: { pty: alert.pty, scope: SCOPE },
  }
  if (alert.urgent) options.vibrate = [40, 60, 40]

  if (workerReg) {
    await workerReg.showNotification(alert.title, options)
    return
  }
  const n = new Notification(alert.title, options)
  n.onclick = () => {
    window.focus()
    if (alert.pty != null) location.hash = `#pty=${alert.pty}`
    n.close()
  }
}
