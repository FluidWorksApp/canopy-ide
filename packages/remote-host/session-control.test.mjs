// Ported from T3 Code (MIT) apps/server/src/preview/SessionControl.test.ts
// (pingdotgg/t3code d5290e9). Same cases, node:test and node:assert instead
// of vitest's expect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserControlInterrupted, SessionControl } from './session-control.mjs';

// expect(promise).rejects.toThrow(match): attaches at once, like vitest does.
const rejects = (promise, match) =>
  assert.rejects(promise, error =>
    typeof match === 'function' ? error instanceof match : String(error?.message).includes(match));
const rejectsWith = (promise, fields) =>
  assert.rejects(promise, error => Object.entries(fields).every(([key, value]) => error?.[key] === value));

test('replaces waiting hover work without changing the running action or delaying the following click', async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.humanLatest('viewer', 'hover:0', undefined, async () => {
    events.push('running');
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  const moves = Array.from({ length: 120 }, (_, position) =>
    control.humanLatest('viewer', 'hover:0', undefined, async () => {
      events.push(position);
    }),
  );
  const click = control.human('viewer', async () => {
    events.push('click');
  });
  finish.resolve();
  await Promise.all([running, ...moves, click]);
  assert.deepEqual(events, ['running', 119, 'click']);
});

for (const barrier of ['human', 'system', 'modifiers']) {
  test(`does not merge waiting hover work across a ${barrier} action`, async () => {
    const control = new SessionControl('agent');
    await control.take('viewer');
    const finish = Promise.withResolvers();
    const events = [];
    const running = control.human('viewer', () => finish.promise);
    const before = control.humanLatest('viewer', 'hover:0', undefined, async () => {
      events.push('before');
    });
    const recordBarrier = async () => {
      events.push('barrier');
    };
    const between =
      barrier === 'modifiers'
        ? control.humanLatest('viewer', 'hover:2', undefined, recordBarrier)
        : barrier === 'system'
          ? control.system(recordBarrier)
          : control.human('viewer', recordBarrier);
    const after = control.humanLatest('viewer', 'hover:0', undefined, async () => {
      events.push('after');
    });
    finish.resolve();
    await Promise.all([running, before, between, after]);
    assert.deepEqual(events, ['before', 'barrier', 'after']);
  });
}

test("does not let another viewer replace or split the owner's waiting hover", async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.human('viewer', () => finish.promise);
  const stale = control.humanLatest('viewer', 'hover', undefined, async () => {
    events.push('stale');
  });
  await rejects(
    control.humanLatest('other', 'hover', undefined, async () => {
      events.push('other');
    }),
    BrowserControlInterrupted,
  );
  const latest = control.humanLatest('viewer', 'hover', undefined, async () => {
    events.push('latest');
  });
  finish.resolve();
  await Promise.all([running, stale, latest]);
  assert.deepEqual(events, ['latest']);
});

for (const handoff of ['release', 'disconnect']) {
  test(`does not revive waiting hover work after ${handoff} and retaking control`, async () => {
    const control = new SessionControl('agent');
    await control.take('viewer');
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const events = [];
    const running = control.human('viewer', () => {
      started.resolve();
      return finish.promise;
    });
    await started.promise;
    const stale = rejects(
      control.humanLatest('viewer', 'hover', undefined, async () => {
        events.push('stale');
      }),
      BrowserControlInterrupted,
    );
    const released = control[handoff]('viewer');
    const retaken = control.take('viewer');
    const fresh = control.humanLatest('viewer', 'hover', undefined, async () => {
      events.push('fresh');
    });
    const latest = control.humanLatest('viewer', 'hover', undefined, async () => {
      events.push('latest');
    });
    finish.resolve();
    await Promise.all([running, stale, released, retaken, fresh, latest]);
    assert.deepEqual(events, ['latest']);
  });
}

test('rejects every caller of a merged hover when the tab closes', async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.human('viewer', () => {
    started.resolve();
    return finish.promise;
  });
  await started.promise;
  const waiting = [1, 2].map(position =>
    rejects(
      control.humanLatest('viewer', 'hover', undefined, async () => {
        events.push(`hover ${position}`);
      }),
      'closed',
    ),
  );
  const closed = control.close();
  await rejects(
    control.humanLatest('viewer', 'hover', undefined, async () => {
      events.push('after close');
    }),
    'closed',
  );
  finish.resolve();
  await Promise.all([running, ...waiting, closed]);
  assert.deepEqual(events, []);
});

test('shares a merged dispatch failure and accepts fresh hover work afterwards', async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.human('viewer', () => finish.promise);
  const first = rejects(
    control.humanLatest('viewer', 'hover', undefined, async () => {
      events.push('superseded');
    }),
    'dispatch failed',
  );
  const last = rejects(
    control.humanLatest('viewer', 'hover', undefined, async () => {
      throw new Error('dispatch failed');
    }),
    'dispatch failed',
  );
  finish.resolve();
  await Promise.all([running, first, last]);
  await control.humanLatest('viewer', 'hover', undefined, async () => {
    events.push('recovered');
  });
  assert.deepEqual(events, ['recovered']);
});

test('waits for tracked navigation before dispatching the latest human hover', async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  const committed = Promise.withResolvers();
  const events = [];
  const navigation = control.human('viewer', async () => {
    control.track(
      committed.promise.then(() => {
        events.push('navigation committed');
      }),
    );
    return 'started';
  });
  const first = control.humanLatest('viewer', 'hover', undefined, async () => {
    events.push('superseded');
  });
  const latest = control.humanLatest('viewer', 'hover', undefined, async () => {
    events.push('latest');
  });
  assert.equal(await navigation, 'started');
  assert.deepEqual(events, []);
  committed.resolve();
  await Promise.all([first, latest]);
  assert.deepEqual(events, ['navigation committed', 'latest']);
});

test('returns an action result before tracked navigation but drains it before already queued actions', async () => {
  const control = new SessionControl('agent');
  const committed = Promise.withResolvers();
  const events = [];
  const navigation = control.agent('agent', async () => {
    control.track(committed.promise.then(() => events.push('navigation committed')));
    return 'started';
  });
  const next = control.agent('agent', async () => events.push('next action'));
  assert.equal(await navigation, 'started');
  assert.deepEqual(events, []);
  committed.resolve();
  await next;
  assert.deepEqual(events, ['navigation committed', 'next action']);
});

test('handles tracked navigation failures without poisoning the next action', async () => {
  const control = new SessionControl('agent');
  const committed = Promise.withResolvers();
  await control.agent('agent', async () => control.track(committed.promise));
  committed.reject(new Error('navigation failed'));
  assert.equal(await control.agent('agent', async () => 'resumed'), 'resumed');
});

test('only lets the assigned agent act and restores that agent after human control', async () => {
  const control = new SessionControl('agent-a');
  await rejects(control.agent('agent-b', async () => 'wrong agent'), BrowserControlInterrupted);
  assert.equal(await control.agent('agent-a', async () => 'first'), 'first');
  await control.take('viewer-a');
  await rejects(control.agent('agent-a', async () => 'racing'), BrowserControlInterrupted);
  assert.equal(await control.human('viewer-a', async () => 'typed'), 'typed');
  await control.release('viewer-a');
  assert.equal(await control.agent('agent-a', async () => 'resumed'), 'resumed');
  await rejects(control.agent('agent-b', async () => 'wrong agent'), BrowserControlInterrupted);
});

test('drains running work before takeover and cancels previously queued agent actions', async () => {
  const control = new SessionControl('agent');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.agent('agent', async () => {
    events.push('agent started');
    started.resolve();
    await finish.promise;
    events.push('agent finished');
  });
  await started.promise;
  const queued = rejects(
    control.agent('agent', async () => events.push('stale agent action')),
    BrowserControlInterrupted,
  );
  const takeover = control.take('viewer');
  const typing = control.human('viewer', async () => events.push('human typed'));
  await rejects(control.agent('agent', async () => 'late action'), BrowserControlInterrupted);
  assert.deepEqual(events, ['agent started']);
  finish.resolve();
  await Promise.all([running, queued, takeover, typing]);
  assert.deepEqual(events, ['agent started', 'agent finished', 'human typed']);
});

test('does not let a second viewer steal, type, release, or disconnect the owner', async () => {
  const control = new SessionControl('agent');
  const takeover = control.take('viewer-a');
  await rejects(control.take('viewer-b'), 'Another viewer');
  await takeover;
  await rejects(control.human('viewer-b', async () => 'wrong viewer'), BrowserControlInterrupted);
  await rejects(control.release('viewer-b'), 'Only the controlling viewer');
  await control.disconnect('viewer-b');
  assert.equal(control.controller, 'viewer-a');
  assert.equal(await control.human('viewer-a', async () => 'still controlled'), 'still controlled');
});

test('invalidates queued human actions and refs when a viewer disconnects', async () => {
  let invalidations = 0;
  const control = new SessionControl('agent', () => invalidations++);
  await control.take('viewer');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const events = [];
  const running = control.human('viewer', async () => {
    started.resolve();
    await finish.promise;
    events.push('human finished');
  });
  await started.promise;
  const queued = rejects(
    control.human('viewer', async () => events.push('stale human action')),
    BrowserControlInterrupted,
  );
  const disconnected = control.disconnect('viewer');
  const resumed = control.agent('agent', async () => events.push('agent resumed'));
  assert.equal(control.generation, 2);
  assert.equal(invalidations, 2);
  finish.resolve();
  await Promise.all([running, queued, disconnected, resumed]);
  assert.deepEqual(events, ['human finished', 'agent resumed']);
});

test('does not revive stale actions when takeover is released before running work finishes', async () => {
  const control = new SessionControl('agent');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const running = control.agent('agent', async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  const staleAgent = rejects(control.agent('agent', async () => 'stale'), BrowserControlInterrupted);
  const takeover = rejects(control.take('viewer'), BrowserControlInterrupted);
  const staleHuman = rejects(control.human('viewer', async () => 'stale'), BrowserControlInterrupted);
  const release = control.release('viewer');
  const resumed = control.agent('agent', async () => 'fresh');
  finish.resolve();
  await Promise.all([running, staleAgent, takeover, staleHuman, release]);
  assert.equal(await resumed, 'fresh');
});

test('closes after running work finishes and never runs queued or new actions', async () => {
  const control = new SessionControl('agent');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const running = control.agent('agent', async () => {
    started.resolve();
    await finish.promise;
    return 'finished';
  });
  await started.promise;
  const queued = rejects(control.agent('agent', async () => 'stale'), 'closed');
  const closed = control.close();
  await rejects(control.take('viewer'), 'closed');
  await rejects(control.agent('agent', async () => 'new'), 'closed');
  finish.resolve();
  assert.equal(await running, 'finished');
  await Promise.all([queued, closed]);
  await control.disconnect('viewer');
  await control.close();
  assert.equal(control.generation, 1);
});

test('lets any agent act on a tab no agent opened, but only while no human controls it', async () => {
  const control = new SessionControl(null);
  assert.equal(await control.agent('agent-a', async () => 'acted'), 'acted');
  await control.take('viewer-a');
  await rejectsWith(control.agent('agent-a', async () => 'racing'), { reason: 'humanControl' });
  assert.equal(await control.observe(async () => 'read'), 'read');
  await control.release('viewer-a');
  assert.equal(await control.agent('agent-b', async () => 'acted'), 'acted');
});

// Canopy: runner.mjs POST /browser answers an interrupted action as a conflict.
test('an interrupted action carries T3 messages, reasons and an HTTP 409 status', async () => {
  const control = new SessionControl('agent');
  await control.take('viewer');
  await rejectsWith(control.agent('agent', async () => 'racing'), { reason: 'humanControl', message: 'A human controls this tab.', status: 409 });
  const plain = new BrowserControlInterrupted();
  assert.equal(plain.reason, 'interrupted');
  assert.equal(plain.message, 'Browser control changed. Refresh the snapshot before trying again.');
});
