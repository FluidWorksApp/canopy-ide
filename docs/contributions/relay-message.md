# Contributing a Team Relay Message

Use this playbook when two Canopy instances need a new peer-to-peer message,
request, or transfer behavior. Do not use the relay for local component events,
agent context calls, or Remote browser RPC.

## Peer flow

```mermaid
sequenceDiagram
  participant ViewA as Sender UI
  participant AppA as Sender App RelayHandle
  participant RustA as Sender RelayManager
  participant RustB as Receiver RelayManager
  participant AppB as Receiver App RelayHandle
  participant ViewB as Receiver UI

  ViewA->>AppA: typed send callback
  AppA->>RustA: Tauri relay command
  RustA->>RustA: validate and encrypt frame
  RustA->>RustB: TCP/WebSocket encrypted frame
  RustB->>RustB: authenticate, decrypt, validate
  RustB-->>AppB: typed Tauri event
  AppB->>AppB: update one app-wide relay projection
  AppB-->>ViewB: RelayHandle state/callbacks
```

## Files

```text
src-tauri/src/relay.rs      wire type, validation, crypto, transport handling
src-tauri/src/wsbridge.rs   async WebSocket bridge when relevant
src/ipc.ts                  typed command/event projection
src/types.ts                app-wide RelayHandle projection
src/App.tsx                 one relay state owner and event subscription
src/components/<feature>    sender/receiver presentation
```

For collaborative editor operations, use `src/collab.ts` and
`src/collab-ot.ts`; do not encode editor mutations as chat.

## Steps

1. Confirm the behavior crosses two Canopy instances.
2. Define a version-tolerant, bounded wire payload.
3. Add strict deserialization and validation in `relay.rs`.
4. Preserve authenticated encryption, monotonic nonces, frame-size caps, and
   peer identity checks.
5. Choose broadcast, direct peer, request/reply, or transfer semantics.
6. Add replay, deduplication, timeout, or acknowledgement where the operation
   needs it.
7. Add a typed Tauri command and receive event wrapper.
8. Let `App` update the existing app-wide `RelayHandle`.
9. Pass state and callbacks to views; never open another relay connection.
10. Route notifications through the existing attention/deep-link path.
11. Test malformed frames, oversized payloads, disconnect, retry, duplicate,
    wrong peer, and successful delivery.

## Primitive decision

```mermaid
flowchart TD
  Need[Cross-instance behavior]
  File{Large file payload?}
  Live{Ordered live document edits?}
  Reply{Needs explicit reply?}
  Transfer[Existing secure file-transfer path]
  Collab[Collaboration OT protocol]
  Request[Typed request/reply message]
  Event[Typed one-way message]

  Need --> File
  File -- yes --> Transfer
  File -- no --> Live
  Live -- yes --> Collab
  Live -- no --> Reply
  Reply -- yes --> Request
  Reply -- no --> Event
```

## Verification

```sh
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features relay::tests
npm run test -- src/collab-ot.test.ts
npm run typecheck
```

Run the feature's focused UI tests as well.

## Pull request checklist

- [ ] Relay is the correct cross-instance boundary.
- [ ] Payload is typed, validated, and bounded.
- [ ] Encryption and identity invariants are preserved.
- [ ] Delivery/reply/retry semantics are explicit.
- [ ] Existing app-wide connection and `RelayHandle` are reused.
- [ ] File transfer or OT protocol reused when applicable.
- [ ] Disconnect, duplicate, malformed, and oversized cases tested.
