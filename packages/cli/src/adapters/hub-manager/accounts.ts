/**
 * Account provisioning for the local hub: `upsertSuperuser` shells out to
 * the PocketBase binary itself (works offline, no running server needed);
 * `createUser` talks to the running hub's REST API as that superuser to
 * create the owner/service application users PocketBase's own admin API
 * does not manage.
 */
import type { ScriptRunner } from "../../ports/script-runner.ts";

/** Runs `pocketbase superuser upsert <email> <password> --dir <pbData>` through `runner`. Throws on a non-zero exit, including stderr/stdout in the message. */
export async function upsertSuperuser(binary: string, pbData: string, email: string, password: string, runner: ScriptRunner): Promise<void> {
  const result = await runner.run(binary, ["superuser", "upsert", email, password, "--dir", pbData], { cwd: pbData });
  if (result.code !== 0) {
    throw new Error(`pocketbase superuser upsert failed: ${result.stderr || result.stdout || `exit code ${result.code}`}`);
  }
}

export type UserRole = "owner" | "service";

export interface CreateUserResult {
  outcome: "created" | "exists";
}

interface AuthResponse {
  token: string;
}

interface LookupResponse {
  items?: unknown[];
}

/**
 * Authenticates as `superuser` against the `_superusers` collection, looks
 * up `user.email` in `users`, and creates it (role `owner` or `service`,
 * `emailVisibility: true`, `verified: true`) when absent. Idempotent: a
 * user that already exists is left untouched and reported as `"exists"`.
 */
export async function createUser(baseUrl: string, superuser: { email: string; password: string }, user: { email: string; password: string; role: UserRole }, doFetch: typeof fetch): Promise<CreateUserResult> {
  const url = baseUrl.replace(/\/+$/, "");

  const authResponse = await doFetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: superuser.email, password: superuser.password }),
  });
  if (!authResponse.ok) {
    throw new Error(`superuser authentication failed: HTTP ${authResponse.status}`);
  }
  const auth = (await authResponse.json()) as AuthResponse;

  const filter = encodeURIComponent(`email="${user.email}"`);
  const lookupResponse = await doFetch(`${url}/api/collections/users/records?filter=${filter}`, {
    headers: { authorization: auth.token },
  });
  if (!lookupResponse.ok) {
    throw new Error(`user lookup failed: HTTP ${lookupResponse.status}`);
  }
  const lookup = (await lookupResponse.json()) as LookupResponse;
  if (lookup.items && lookup.items.length > 0) {
    return { outcome: "exists" };
  }

  const createResponse = await doFetch(`${url}/api/collections/users/records`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth.token },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
      passwordConfirm: user.password,
      role: user.role,
      emailVisibility: true,
      verified: true,
    }),
  });
  if (!createResponse.ok) {
    throw new Error(`user creation failed: HTTP ${createResponse.status}`);
  }
  return { outcome: "created" };
}
