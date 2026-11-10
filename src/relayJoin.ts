// A teammate's "Connect" on a desktop-relay card in team chat. The card was
// validated to a local-network address (cardSchema.validRelayAddr); the click
// is the person's consent. App performs the join, since it owns the relay.
export const RELAY_JOIN_EVENT = "canopy:relay-join";
export interface RelayJoinDetail {
  addr: string;
  code: string;
  from: string;
}
