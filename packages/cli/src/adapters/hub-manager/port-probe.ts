/**
 * Free-port probe for the local hub: bind `127.0.0.1:<port>` with
 * `node:net` and release it again. The binder is injectable so every test
 * but the one proving the real binder works uses a fake.
 */
import { createServer } from "node:net";

const LOOPBACK = "127.0.0.1";
const MAX_PORT = 65535;

/** Binds `host:port` and resolves with a function that releases it; rejects when the port cannot be bound. */
export type PortBinder = (port: number, host: string) => Promise<() => Promise<void>>;

/** The real binder: a `node:net` server listening on `host:port`. */
export const realPortBinder: PortBinder = (port, host) =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve(() => new Promise<void>((done) => server.close(() => done())));
    });
  });

/** `true` when `127.0.0.1:<port>` can be bound (it is released again before returning); `false` on any bind error. */
export async function isPortFree(port: number, bind: PortBinder = realPortBinder): Promise<boolean> {
  try {
    const release = await bind(port, LOOPBACK);
    await release();
    return true;
  } catch {
    return false;
  }
}

/** The first free port among `from`, `from + 1`, … (at most `tries` candidates, never above 65535), or `undefined` when none is free. */
export async function firstFreePort(from: number, tries = 20, bind: PortBinder = realPortBinder): Promise<number | undefined> {
  for (let offset = 0; offset < tries; offset += 1) {
    const port = from + offset;
    if (port > MAX_PORT) return undefined;
    if (await isPortFree(port, bind)) return port;
  }
  return undefined;
}
