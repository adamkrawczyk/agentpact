// SSRF-guarded artifact fetch for deterministic delivery validators.
//
// A seller controls the artifact URL, and the API fetches it — the textbook
// SSRF shape. Guards, all enforced per hop:
//   - https only (no http, file, gopher, …), no credentials in the URL;
//   - the hostname is resolved ONCE here, every resolved address must be
//     public (no private, loopback, link-local, CGNAT, multicast, reserved,
//     IPv4-mapped/NAT64/6to4 forms of those), and the socket is PINNED to the
//     vetted address via the `lookup` hook — a DNS rebind between check and
//     connect cannot redirect the connection;
//   - IP-literal hosts are checked directly (Node skips `lookup` for them);
//   - redirects are followed manually (max 3), each hop re-validated;
//   - size cap (Content-Length AND streamed byte count) and one overall deadline.

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupAddress } from "node:dns";

export class ArtifactFetchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ArtifactFetchError";
  }
}

// Two lists: Node's BlockList matches IPv4 input against IPv4-mapped IPv6
// rules, so ::ffff:0:0/96 in a shared list would block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(net, prefix, "ipv6");

/** IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) → the embedded IPv4, else null. */
function mappedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True only for globally routable unicast addresses. Unknown input → false. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(bare);
  if (family === 4) return !blockedV4.check(bare, "ipv4");
  if (family === 6) {
    const v4 = mappedV4(bare);
    if (v4) return isIP(v4) === 4 && !blockedV4.check(v4, "ipv4");
    return !blockedV6.check(bare, "ipv6");
  }
  return false;
}

export type AddressPolicy = (address: string, hostname: string) => boolean;
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface FetchArtifactOptions {
  /** Hard cap on bytes read. */
  maxBytes: number;
  /** One deadline for the whole fetch, redirects included. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test seams; production uses DNS + isPublicAddress. Not reachable from request input. */
  resolve?: Resolver;
  addressPolicy?: AddressPolicy;
  ca?: string | Buffer;
}

const defaultResolve: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArtifactFetchError("INVALID_URL", `artifact URL is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new ArtifactFetchError("NOT_HTTPS", `artifact URL must be https (got ${url.protocol})`);
  if (url.username || url.password) throw new ArtifactFetchError("CREDENTIALS_IN_URL", "artifact URL must not carry credentials");
  return url;
}

/** Resolve + vet the host. Returns the address to pin the socket to. */
async function vetHost(url: URL, resolve: Resolver, policy: AddressPolicy): Promise<LookupAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!policy(host, host)) throw new ArtifactFetchError("PRIVATE_ADDRESS", `artifact host ${host} is not a public address`);
    return { address: host, family: isIP(host) };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ArtifactFetchError("DNS_FAILED", `could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new ArtifactFetchError("DNS_FAILED", `no addresses for ${host}`);
  // Every address must be public: a host that resolves to one public and one
  // private address is treated as hostile (round-robin rebinding).
  for (const a of addresses) {
    if (!policy(a.address, host)) throw new ArtifactFetchError("PRIVATE_ADDRESS", `${host} resolves to a non-public address`);
  }
  return addresses[0];
}

/**
 * Fetch an artifact and stream its bytes to `onChunk`. Resolves with the
 * total byte count. Throws ArtifactFetchError on any guard violation.
 */
export async function fetchArtifact(
  rawUrl: string,
  opts: FetchArtifactOptions,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ bytes: number; finalUrl: string; contentType: string | null }> {
  const resolve = opts.resolve ?? defaultResolve;
  const policy = opts.addressPolicy ?? ((ip: string) => isPublicAddress(ip));
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = assertFetchableUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    const pinned = await vetHost(current, resolve, policy);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ArtifactFetchError("TIMEOUT", "artifact fetch timed out");

    const res = await new Promise<IncomingMessage>((resolveRes, reject) => {
      const req = httpsRequest(current, {
        method: "GET",
        headers: { "user-agent": "AgentPact-Validator/1.0", accept: "*/*", "accept-encoding": "identity" },
        ca: opts.ca,
        // Pin the TCP connection to the address vetted above.
        lookup: (_hostname, options, cb) => {
          if ((options as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [pinned]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
        timeout: remaining,
      });
      const timer = setTimeout(() => req.destroy(new ArtifactFetchError("TIMEOUT", "artifact fetch timed out")), remaining);
      req.on("response", (r) => { clearTimeout(timer); resolveRes(r); });
      req.on("timeout", () => req.destroy(new ArtifactFetchError("TIMEOUT", "artifact fetch timed out")));
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e instanceof ArtifactFetchError ? e : new ArtifactFetchError("FETCH_FAILED", `artifact fetch failed: ${e.message}`));
      });
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new ArtifactFetchError("TOO_MANY_REDIRECTS", "artifact URL redirects too many times");
      current = assertFetchableUrl(new URL(res.headers.location, current).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new ArtifactFetchError("HTTP_STATUS", `artifact URL answered HTTP ${status}`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy();
      throw new ArtifactFetchError("TOO_LARGE", `artifact is ${declared} bytes, cap is ${opts.maxBytes}`);
    }

    let total = 0;
    const left = deadline - Date.now();
    const timer = setTimeout(() => res.destroy(new ArtifactFetchError("TIMEOUT", "artifact fetch timed out")), Math.max(left, 0));
    try {
      for await (const chunk of res) {
        const bytes = chunk as Uint8Array;
        total += bytes.byteLength;
        if (total > opts.maxBytes) {
          res.destroy();
          throw new ArtifactFetchError("TOO_LARGE", `artifact exceeds the ${opts.maxBytes}-byte cap`);
        }
        await onChunk(bytes);
      }
    } catch (e) {
      if (e instanceof ArtifactFetchError) throw e;
      throw new ArtifactFetchError("FETCH_FAILED", `artifact read failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    return { bytes: total, finalUrl: current.toString(), contentType: (res.headers["content-type"] as string | undefined) ?? null };
  }
}
