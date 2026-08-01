// The single source of truth for what an agent is doing.
//
// Import from here and nowhere else. `src/agentLifeGuard.test.ts` fails the
// build if a surface computes a lifecycle state on its own — the same doctrine
// as `branchSwitchGuard.test.ts`: the point of the test is that there is
// exactly one place the answer comes from, so do not fix a failure by adding an
// exemption.
//
// The shape:
//   vocabulary  the words. LifeState, Confidence, Via, Attention.
//   fidelity    what each CLI can actually prove about itself.
//   policy      every threshold, once.
//   ladder      PURE: evidence -> Life. Ranked rungs, first match wins.
//   attention   PURE: what you have not dealt with. A separate axis.
//   compose     PURE: the two axes meeting. Buckets, dots, reclaimability.
//   bind        which session is in which terminal, answered once.
//
// Everything except `bind`'s snapshot is pure and takes `now` as an argument.
// The impure edge — subscriptions, the clock, the attention memory — is
// `src/agentLifeStore.ts` on the desktop and `shared/model.ts` in the portal.
export * from "./vocabulary";
export * from "./fidelity";
export * from "./policy";
export * from "./ladder";
export * from "./attention";
export * from "./compose";
export * from "./bind";
