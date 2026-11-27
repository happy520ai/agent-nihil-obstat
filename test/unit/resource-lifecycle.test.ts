import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installProcessCleanupOn,
  RESOURCE_PROCESS_CLEANUP_SIGNALS,
  ResourceRegistry,
  ResourceRegistryError,
  resourceSourceOf,
  type ProcessCleanupTarget,
  type ResourceSnapshot,
} from '../../src/memory/resource-lifecycle.ts';

function watermarks(partial: Partial<ResourceSnapshot>): { resourceWatermarks(): Partial<ResourceSnapshot> } {
  return { resourceWatermarks: () => partial };
}

class FakeTarget implements ProcessCleanupTarget {
  readonly pid = 4_242;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  on(signal: NodeJS.Signals, listener: () => void): this {
    const set = this.listeners.get(signal) ?? new Set();
    set.add(listener);
    this.listeners.set(signal, set);
    return this;
  }

  removeListener(signal: NodeJS.Signals, listener: () => void): this {
    this.listeners.get(signal)?.delete(listener);
    return this;
  }

  kill(pid: number, signal: NodeJS.Signals): boolean {
    this.killed.push({ pid, signal });
    return true;
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }

  count(signal: NodeJS.Signals): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

test('snapshot sums registered sources and ignores absent counters', () => {
  const registry = new ResourceRegistry();
  const unregister = registry.register(watermarks({ pendingRequests: 2, activeTimers: 1 }));
  registry.register(watermarks({ openSockets: 3, liveChildren: 4 }));
  assert.deepEqual(registry.snapshot(), {
    pendingRequests: 2,
    openSockets: 3,
    liveChildren: 4,
    activeTimers: 1,
  });
  unregister();
  assert.deepEqual(registry.snapshot(), {
    pendingRequests: 0,
    openSockets: 3,
    liveChildren: 4,
    activeTimers: 0,
  });
  assert.equal(registry.closed, false);
});

test('close runs cleanups LIFO exactly once and rejects late registration', async () => {
  const registry = new ResourceRegistry();
  const order: string[] = [];
  registry.registerCleanup(() => {
    order.push('first');
  });
  registry.registerCleanup(async () => {
    order.push('second');
  });
  await registry.close();
  assert.deepEqual(order, ['second', 'first']);
  assert.equal(registry.closed, true);
  await registry.close();
  assert.deepEqual(order, ['second', 'first']);
  assert.throws(
    () => registry.register(watermarks({})),
    (error: unknown) => error instanceof ResourceRegistryError && error.code === 'RESOURCE_REGISTRY_CLOSED',
  );
  assert.throws(
    () => registry.registerCleanup(() => undefined),
    (error: unknown) => error instanceof ResourceRegistryError,
  );
});

test('a cleanup can be unregistered before close', async () => {
  const registry = new ResourceRegistry();
  let ran = false;
  const unregister = registry.registerCleanup(() => {
    ran = true;
  });
  unregister();
  unregister();
  await registry.close();
  assert.equal(ran, false);
});

test('a failing cleanup does not stop the others and surfaces as AggregateError', async () => {  const registry = new ResourceRegistry();
  const order: string[] = [];
  registry.registerCleanup(() => {
    order.push('safe');
  });
  registry.registerCleanup(() => {
    throw new Error('cleanup failed');
  });
  await assert.rejects(
    () => registry.close(),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 1,
  );
  assert.deepEqual(order, ['safe']);
  assert.equal(registry.closed, true);
});

test('resourceSourceOf fills absent counters with zero', () => {
  const source = resourceSourceOf(watermarks({ liveChildren: 2 }));
  assert.deepEqual(source.resourceWatermarks(), {
    pendingRequests: 0,
    openSockets: 0,
    liveChildren: 2,
    activeTimers: 0,
  });
});

test('a handled signal closes the registry and re-raises the same signal', async () => {
  const target = new FakeTarget();
  const registry = new ResourceRegistry();
  const order: string[] = [];
  registry.registerCleanup(() => {
    order.push('closed');
  });
  const dispose = installProcessCleanupOn(target, registry);
  assert.deepEqual([...RESOURCE_PROCESS_CLEANUP_SIGNALS], ['SIGINT', 'SIGTERM']);
  assert.equal(target.count('SIGINT'), 1);
  assert.equal(target.count('SIGTERM'), 1);

  target.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['closed']);
  assert.deepEqual(target.killed, [{ pid: 4_242, signal: 'SIGTERM' }]);
  assert.equal(target.count('SIGINT'), 0);
  assert.equal(target.count('SIGTERM'), 0);
  // A second signal after the handlers were disposed has no effect.
  target.emit('SIGTERM');
  assert.deepEqual(target.killed, [{ pid: 4_242, signal: 'SIGTERM' }]);
  dispose();
});

test('the disposer removes handlers without running cleanups', () => {
  const target = new FakeTarget();
  const registry = new ResourceRegistry();
  let closed = false;
  registry.registerCleanup(() => {
    closed = true;
  });
  const dispose = installProcessCleanupOn(target, registry, { signals: ['SIGINT'] });
  assert.equal(target.count('SIGINT'), 1);
  dispose();
  dispose();
  assert.equal(target.count('SIGINT'), 0);
  target.emit('SIGINT');
  assert.equal(closed, false);
  assert.deepEqual(target.killed, []);
});

test('cleanup failure still re-raises the signal', async () => {
  const target = new FakeTarget();
  const registry = new ResourceRegistry();
  registry.registerCleanup(() => {
    throw new Error('boom');
  });
  installProcessCleanupOn(target, registry, { signals: ['SIGINT'] });
  target.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(target.killed, [{ pid: 4_242, signal: 'SIGINT' }]);
  assert.equal(registry.closed, true);
});
