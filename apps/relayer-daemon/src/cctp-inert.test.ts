// apps/relayer-daemon/src/cctp-inert.test.ts — M1 (lane m1-relay)
//
// Boot-path proof that CCTP_ENABLED unset/false leaves the relayer exactly as
// it was before M1: the CCTP modules and @agentpact/payouts are not even
// LOADED by the daemon entrypoint (they are only reached through dynamic
// import() inside the enabled branch), so a defect in them can never stop the
// money-path sweepers from booting. cctp-daemon.test.ts covers the runtime
// side (no timer fires, no Iris/chain/store call, /health says disabled).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Specifiers of STATIC value imports/re-exports (type-only imports are erased at compile time). */
function staticSpecifiers(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]!);
  return out;
}

function staticClosure(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      const ts = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(ts)) queue.push(ts);
    }
  }
  return { files, bare };
}

describe("CCTP_ENABLED off — boot path is inert", () => {
  const entry = resolve(here, "index.ts");
  const { files, bare } = staticClosure(entry);

  it("the daemon entrypoint statically loads no CCTP module and not @agentpact/payouts", () => {
    assert.ok(files.size > 3, "sanity: the closure walker found the sweeper modules");
    const cctpFiles = [...files].filter((f) => /\/cctp-[^/]+\.ts$/.test(f));
    assert.deepEqual(cctpFiles, [], "index.ts must not statically import cctp-*.ts");
    assert.equal(bare.has("@agentpact/payouts"), false);
  });

  it("every CCTP module is reached only through a dynamic import() in index.ts", () => {
    const src = readFileSync(entry, "utf8");
    const dyn = [...src.matchAll(/await import\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    assert.ok(dyn.includes("./cctp-sweeper.js") && dyn.includes("@agentpact/payouts"));
    // buildCctpRuntime (the only place that loads them at boot) has one call site, guarded by the flag.
    const callSites = src.split("\n").filter((l) => /\bbuildCctpRuntime\(/.test(l) && !/function buildCctpRuntime/.test(l));
    assert.equal(callSites.length, 1);
    assert.match(callSites[0]!, /config\.cctpEnabled\s*\?/);
    // the interval is only created inside the enabled branch
    assert.match(src, /if \(config\.cctpEnabled === true\) \{[\s\S]*?cctpTimer = setInterval/);
  });

  it("unset, empty, 'false', '0', 'yes' and '1' all load as disabled", () => {
    for (const v of [undefined, "", "false", "FALSE", "0", "1", "yes", "on"]) {
      assert.equal(loadConfig({ CCTP_ENABLED: v }).cctpEnabled, false, `CCTP_ENABLED=${String(v)}`);
    }
  });
});
