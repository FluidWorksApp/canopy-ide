// React's view of the attention channel. useSyncExternalStore rather than a
// state + effect pair, same call as usePrWatch: the rail badge, the project
// tabs, the toasts and the notification list all read the same snapshot in the
// same render, which is the whole point of there being one channel.
import { useSyncExternalStore } from "react";
import {
  attentionItems,
  subscribeAttention,
  type AttentionItem,
} from "./attention";

/** With a selector, a consumer only re-renders when its slice changes identity
 *  — a project tab reads its own count and should not wake for someone else's
 *  toast. The selector must return something identity-stable, so derive counts
 *  and booleans here rather than fresh arrays. */
export function useAttention(): AttentionItem[];
export function useAttention<T>(selector: (items: AttentionItem[]) => T): T;
export function useAttention<T>(
  selector?: (items: AttentionItem[]) => T,
): T | AttentionItem[] {
  const get: () => T | AttentionItem[] = selector
    ? () => selector(attentionItems())
    : attentionItems;
  return useSyncExternalStore(subscribeAttention, get, get);
}
