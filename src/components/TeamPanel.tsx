import type {AccountConversation} from "./AccountChatView";
import {TeamHub} from "./TeamHub";
import {LiveSessions} from "./LiveSessions";
// Team side panel. Signed in, a Canopy account is the whole connection: teams,
// presence and messages join by themselves (teamMessaging/background.ts), and
// Live now lists the terminals shared with you. Signed out, there is nothing
// to share with, so the panel says how to get there.
import * as ipc from "../ipc";
import type { Notify } from "../types";
import { basename } from "../paths";

interface TeamPanelProps {
  onOpenAccountChat?: (conversation:AccountConversation)=>void;
  /** False while the panel is hidden behind another side tab: Live now stops polling. */
  visible?: boolean;
}

/** Pick a file and offer it to a member — the transfer itself runs
 *  peer-to-peer; the outcome comes back as a relay:transfer event. */
export async function offerFileTo(memberId: string, memberName: string, onNotice: Notify) {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ title: `Send a file to ${memberName}` });
  if (typeof path !== "string") return;
  try {
    await ipc.relayOfferFile(memberId, path);
    onNotice(`Offered ${basename(path)} to ${memberName} — sends when they accept.`, "success");
  } catch (err) {
    onNotice(String(err), "error");
  }
}

/** Live now sits under the team picker, above the conversations, so a shared
 *  session is the first thing seen. Signed out, TeamHub asks for a sign-in
 *  ("Sign in to share with your team") and nothing offers to share. */
export function TeamPanel({onOpenAccountChat,visible=true}: TeamPanelProps){
 return <div style={{height:"100%",overflow:"auto"}}><TeamHub onOpenChat={onOpenAccountChat} live={<LiveSessions visible={visible}/>}/></div>;
}
