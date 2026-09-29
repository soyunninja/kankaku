import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { firstFreePort, isPortFree, realPortBinder } from "../src/adapters/hub-manager/port-probe.ts";
import type { PortBinder } from "../src/adapters/hub-manager/port-probe.ts";

/** A fake binder: ports in `taken` refuse to bind; every bind and release is recorded. */
function fakeBinder(taken: number[]): { binder: PortBinder; binds: { port: number; host: string }[]; released: number[] } {
  const binds: { port: number; host: string }[] = [];
  const released: number[] = [];
  const binder: PortBinder = async (port, host) => {
    binds.push({ port, host });
    if (taken.includes(port)) throw Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    return async () => {
      released.push(port);
    };
  };
  return { binder, binds, released };
}

test("isPortFree: binds 127.0.0.1:<port>, releases it again and reports true", async () => {
  const { binder, binds, released } = fakeBinder([]);
  assert.equal(await isPortFree(8090, binder), true);
  assert.deepEqual(binds, [{ port: 8090, host: "127.0.0.1" }]);
  assert.deepEqual(released, [8090]);
});

test("isPortFree: false when the port cannot be bound", async () => {
  const { binder, released } = fakeBinder([8090]);
  assert.equal(await isPortFree(8090, binder), false);
  assert.deepEqual(released, []);
});

test("firstFreePort: returns the first free port at or above `from`", async () => {
  const { binder } = fakeBinder([8090, 8091]);
  assert.equal(await firstFreePort(8090, 20, binder), 8092);
  assert.equal(await firstFreePort(8090, undefined, binder), 8092);
});

test("firstFreePort: undefined once `tries` ports in a row are taken", async () => {
  const { binder, binds } = fakeBinder([8090, 8091, 8092]);
  assert.equal(await firstFreePort(8090, 3, binder), undefined);
  assert.equal(binds.length, 3);
});

test("firstFreePort: never goes past 65535", async () => {
  const { binder, binds } = fakeBinder([65534, 65535]);
  assert.equal(await firstFreePort(65534, 20, binder), undefined);
  assert.deepEqual(binds.map((b) => b.port), [65534, 65535]);
});

test("realPortBinder: sees a port the OS handed to a live listener as taken, and free again once it closes", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  try {
    assert.equal(await isPortFree(port, realPortBinder), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await isPortFree(port, realPortBinder), true);
});
