/**
 * Pure local-hub domain: parsing and validating `kankaku-hub`'s
 * `hub-manifest.json`, picking the right PocketBase release asset for this
 * machine, the `~/.kankaku/hub` on-disk layout, the `pocketbase serve`
 * argv, the persisted `hub.json`/`accounts.json` shapes, status
 * classification, and password generation. No I/O, no `Date.now()` —
 * callers (`src/adapters/hub-manager/*.ts`) read the real files/processes
 * and pass plain facts in.
 */

export type AssetKey = "darwin-arm64" | "darwin-amd64" | "linux-arm64" | "linux-amd64";

const ASSET_KEYS: AssetKey[] = ["darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64"];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export interface HubManifestAsset {
  file: string;
  url: string;
  sha256: string;
}

export interface HubManifest {
  name: string;
  version: string;
  schemaVersion: string;
  migrations: string[];
  pocketbase: {
    version: string;
    assets: Record<AssetKey, HubManifestAsset>;
  };
  serve: {
    http: string;
    migrationsDir: string;
    hooksDir: string;
    publicDir: string;
  };
}

function fail(message: string): never {
  throw new Error(`invalid hub manifest: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function parseAsset(value: unknown, path: string): HubManifestAsset {
  const record = asRecord(value, path);
  const file = nonEmptyString(record["file"], `${path}.file`);
  const url = nonEmptyString(record["url"], `${path}.url`);
  const sha256 = nonEmptyString(record["sha256"], `${path}.sha256`);
  if (!SHA256_HEX_PATTERN.test(sha256)) fail(`${path}.sha256 must be a 64-character hex string`);
  return { file, url, sha256 };
}

/**
 * Validates and narrows `json` (typically `JSON.parse`d from
 * `hub-manifest.json`) into a `HubManifest`. Throws `Error` with a precise
 * message identifying the first invalid field.
 */
export function parseHubManifest(json: unknown): HubManifest {
  const root = asRecord(json, "manifest");

  const name = nonEmptyString(root["name"], "name");
  if (name !== "kankaku-hub") fail(`name must be "kankaku-hub", got ${JSON.stringify(name)}`);

  const version = nonEmptyString(root["version"], "version");
  const schemaVersion = nonEmptyString(root["schemaVersion"], "schemaVersion");

  const migrations = root["migrations"];
  if (!Array.isArray(migrations) || migrations.length === 0) fail("migrations must be a non-empty array of strings");
  for (const [index, entry] of migrations.entries()) {
    nonEmptyString(entry, `migrations[${index}]`);
  }

  const pocketbase = asRecord(root["pocketbase"], "pocketbase");
  const pocketbaseVersion = nonEmptyString(pocketbase["version"], "pocketbase.version");
  const assetsRecord = asRecord(pocketbase["assets"], "pocketbase.assets");
  const assets = {} as Record<AssetKey, HubManifestAsset>;
  for (const key of ASSET_KEYS) {
    if (!(key in assetsRecord)) fail(`pocketbase.assets.${key} is missing`);
    assets[key] = parseAsset(assetsRecord[key], `pocketbase.assets.${key}`);
  }

  const serveRecord = asRecord(root["serve"], "serve");
  const serve = {
    http: nonEmptyString(serveRecord["http"], "serve.http"),
    migrationsDir: nonEmptyString(serveRecord["migrationsDir"], "serve.migrationsDir"),
    hooksDir: nonEmptyString(serveRecord["hooksDir"], "serve.hooksDir"),
    publicDir: nonEmptyString(serveRecord["publicDir"], "serve.publicDir"),
  };

  return {
    name,
    version,
    schemaVersion,
    migrations: migrations as string[],
    pocketbase: { version: pocketbaseVersion, assets },
    serve,
  };
}

/**
 * Maps `process.platform`/`process.arch` to the manifest's asset key
 * (`x64` → `amd64`). Throws for anything other than macOS/Linux on
 * arm64/x64 — kankaku hub ships no other PocketBase build.
 */
export function assetKeyFor(platform: NodeJS.Platform, arch: string): AssetKey {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (!os || !cpu) throw new Error(`unsupported platform ${platform}/${arch}: kankaku hub runs on macOS and Linux`);
  return `${os}-${cpu}` as AssetKey;
}

export interface HubLayout {
  root: string;
  bin: string;
  binary: string;
  pbData: string;
  appDir: (version: string) => string;
  currentFile: string;
  hubJson: string;
  accountsJson: string;
  /** The local hub's service account (`{ url, email, password }`, 0600), always written by install; `credentials.json` is only derived from it. */
  serviceJson: string;
  pidFile: string;
  logFile: string;
}

function joinPath(...segments: string[]): string {
  return segments.join("/");
}

/** The on-disk layout of the local hub under `<homeDir>/.kankaku/hub`. */
export function hubLayout(homeDir: string): HubLayout {
  const root = joinPath(homeDir, ".kankaku", "hub");
  return {
    root,
    bin: joinPath(root, "bin"),
    binary: joinPath(root, "bin", "pocketbase"),
    pbData: joinPath(root, "pb_data"),
    appDir: (version: string) => joinPath(root, "app", version),
    currentFile: joinPath(root, "current"),
    hubJson: joinPath(root, "hub.json"),
    accountsJson: joinPath(root, "accounts.json"),
    serviceJson: joinPath(root, "service.json"),
    pidFile: joinPath(root, "pid"),
    logFile: joinPath(root, "hub.log"),
  };
}

/** The `pocketbase serve` argv for `appVersion`'s app copy, listening on `127.0.0.1:<port>`. */
export function serveArgs(layout: HubLayout, appVersion: string, port: number): string[] {
  const appDir = layout.appDir(appVersion);
  return [
    "serve",
    "--http",
    `127.0.0.1:${port}`,
    "--dir",
    layout.pbData,
    "--migrationsDir",
    joinPath(appDir, "pocketbase", "pb_migrations"),
    "--hooksDir",
    joinPath(appDir, "pocketbase", "pb_hooks"),
    "--publicDir",
    joinPath(appDir, "public"),
  ];
}

/** Persisted at `hubLayout(...).hubJson`: the installed hub's port and versions. */
export interface HubConfig {
  port: number;
  appVersion: string;
  pocketbaseVersion: string;
  installedAt: string;
}

function fieldFail(message: string): never {
  throw new Error(`invalid hub config: ${message}`);
}

/** Validates and narrows `json` (typically `JSON.parse`d from `hub.json`) into a `HubConfig`. */
export function parseHubConfig(json: unknown): HubConfig {
  if (!json || typeof json !== "object" || Array.isArray(json)) fieldFail("config must be an object");
  const record = json as Record<string, unknown>;
  const port = record["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) fieldFail("port must be a positive integer");
  const appVersion = record["appVersion"];
  if (typeof appVersion !== "string" || appVersion.length === 0) fieldFail("appVersion must be a non-empty string");
  const pocketbaseVersion = record["pocketbaseVersion"];
  if (typeof pocketbaseVersion !== "string" || pocketbaseVersion.length === 0) fieldFail("pocketbaseVersion must be a non-empty string");
  const installedAt = record["installedAt"];
  if (typeof installedAt !== "string" || installedAt.length === 0) fieldFail("installedAt must be a non-empty string");
  return { port, appVersion, pocketbaseVersion, installedAt };
}

/** Persisted at `hubLayout(...).accountsJson` (0600): the superuser and owner account emails/password. */
export interface HubAccounts {
  superuserEmail: string;
  superuserPassword: string;
  ownerEmail: string;
}

export interface ClassifyStatusInput {
  installed: boolean;
  config?: HubConfig;
  pidAlive: boolean;
  health: "ok" | "failed" | "skipped";
}

export interface HubStatus {
  state: "not-installed" | "stopped" | "running" | "unhealthy";
  url?: string;
  version?: string;
}

/**
 * Classifies the local hub's status from plain, already-gathered facts:
 * not installed (or installed with no readable config), installed but not
 * running (`stopped`), running and healthy or health not checked
 * (`running`), or running but failing its health check (`unhealthy`).
 */
export function classifyStatus(input: ClassifyStatusInput): HubStatus {
  if (!input.installed || !input.config) return { state: "not-installed" };
  const { config } = input;
  if (!input.pidAlive) return { state: "stopped", version: config.appVersion };

  const url = `http://127.0.0.1:${config.port}`;
  if (input.health === "failed") return { state: "unhealthy", url, version: config.appVersion };
  return { state: "running", url, version: config.appVersion };
}

const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Generates a URL-safe password of `length` characters (default 24) from
 * `randomBytes`, an injected source of `n` random bytes — deterministic
 * under a fake RNG in tests, `node:crypto#randomBytes` in production. The
 * 64-character alphabet divides evenly into a byte's 256 values, so
 * `byte % 64` introduces no modulo bias.
 */
export function generatePassword(randomBytes: (n: number) => Uint8Array, length = 24): string {
  const bytes = randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return password;
}

/** Persisted at `hubLayout(...).serviceJson` (0600): the local hub's service account, in the same shape as `credentials.json`. */
export interface ServiceAccount {
  url: string;
  email: string;
  password: string;
}

/** Narrows `json` to a `ServiceAccount` (three non-empty strings), or `undefined` when it is anything else. */
export function parseServiceAccount(json: unknown): ServiceAccount | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const record = json as Record<string, unknown>;
  const { url, email, password } = record;
  if (typeof url !== "string" || url === "" || typeof email !== "string" || email === "" || typeof password !== "string" || password === "") return undefined;
  return { url, email, password };
}

function hostAndPort(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    return `${parsed.protocol}//${host}:${parsed.port}`;
  } catch {
    return undefined;
  }
}

/** Whether two hub URLs name the same scheme, host and port (`localhost` and `127.0.0.1` are the same host; a trailing slash or path is ignored). An unparsable URL never matches. */
export function sameHubUrl(a: string, b: string): boolean {
  const left = hostAndPort(a);
  return left !== undefined && left === hostAndPort(b);
}

/** Install may write `~/.kankaku/credentials.json` only when none exists, or when it already points at this local hub. */
export function shouldWriteCredentials(existingUrl: string | undefined, localUrl: string): boolean {
  return existingUrl === undefined || sameHubUrl(existingUrl, localUrl);
}

/** The `sync credentials` step's detail when install leaves `credentials.json` alone. */
export function credentialsKeptDetail(existingUrl: string): string {
  return `this machine syncs to ${existingUrl}; run 'kankaku hub use' to switch to the local hub`;
}

/** Where this machine's sync points, for `kankaku hub status`: `local hub`, the other hub's URL, or `not configured`. */
export function describeSyncTarget(credentialsUrl: string | undefined, localUrl: string | undefined): string {
  if (credentialsUrl === undefined) return "not configured";
  return localUrl !== undefined && sameHubUrl(credentialsUrl, localUrl) ? "local hub" : credentialsUrl;
}
