import { useEffect, useReducer } from "react";
import { createChannel } from "./channel";

// One interval for the whole app, shared by every component that needs a clock
// on screen to advance. A running-agent panel can hold a dozen live timers, and
// a dozen `setInterval(…, 1000)` is a dozen wakeups a second on a machine whose
// whole job is to leave CPU for the agents.
//
// Subscribing is also what keeps the interval alive: with nothing on screen
// counting there is no timer at all, so an app sitting on a diff view is not
// paying for a heartbeat nobody reads.
let timer: number | undefined;
const clock = createChannel(0, {
  onActive: () => {
    timer = window.setInterval(() => clock.set(clock.get() + 1), 1000);
  },
  onIdle: () => {
    window.clearInterval(timer);
    timer = undefined;
  },
});

/**
 * Re-render this component once a second while `running` is true.
 *
 * For a clock that has to move on its own — an elapsed timer — where nothing
 * else would cause a render. Use it in the smallest component that shows the
 * number, never in the panel around it: a once-a-second render of a list of
 * agent rows costs a great deal more than a once-a-second render of the six
 * characters that changed.
 */
export function useSecondTick(running: boolean): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (running ? clock.subscribe(tick) : undefined), [running, tick]);
}
