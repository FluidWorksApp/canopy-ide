export function registrationProof(userId: string, input: unknown, now?: number): {agreement: JsonWebKey; signing: JsonWebKey};
export function relayEnvelope(input: unknown, userId: string, sender: unknown, recipient: unknown, now?: number): Record<string, unknown>;
export function peerAction(db: unknown, user: unknown, input: unknown): Promise<Record<string, unknown>>;
