// A teammate's "Connect" on a desktop-relay card in team chat. The card was
// validated to a local-network address (cardSchema.validRelayAddr); the click
// is the person's consent. App performs the join, since it owns the relay.
export const RELAY_JOIN_EVENT = "canopy:relay-join";
export interface RelayJoinDetail {
  addr: string;
  code: string;
  from: string;
}

// "Stop sharing" on the request card in team chat. App ends the relay.
export const RELAY_STOP_EVENT = "canopy:relay-stop";

// The other side: a teammate asked to connect remotely (a relay-request card)
// and this person pressed Accept. App starts the internet link and the relay,
// then answers with a relay-offer card addressed to the requester.
export const RELAY_ACCEPT_EVENT = "canopy:relay-accept";
export interface RelayAcceptDetail {
  /** Teammate id to answer. */
  to: string;
  from: string;
  /** Called when sharing could not start, so Accept can be tried again. */
  onFail?: () => void;
}
