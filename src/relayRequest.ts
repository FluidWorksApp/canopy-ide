import { post } from "./components/RelayConnect";

/** "Connect remotely": ask a teammate, in their direct conversation, to share
 *  their whole desktop. They see an Accept card; nothing starts before that. */
export function postRelayRequest(team: string, self: string, peer: string): Promise<string> {
  return post(team, self, { type: "relay-request", v: 1 }, peer);
}
