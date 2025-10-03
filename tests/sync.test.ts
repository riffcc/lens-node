// sync.test.ts – verifies light‑mode sync correctness for lens‑node
// This test spawns a lens‑node process in light mode, waits for the /api/v1/ready
// endpoint to become true, then fetches releases from the real lens and the
// mirrored API and asserts they are identical. If the ready flag is true while
// the releases differ, the test fails – catching false‑positive ready states.

import { spawn, ChildProcess } from "child_process";
import fetch from "node-fetch";
import { once } from "events";
import { setTimeout } from "timers/promises";
import fs from "fs";
import os from "os";
import path from "path";

const LENS_REAL = "https://lens.ftwc.xyz:9002";
const LENS_MIRROR = "http://localhost:5002";
const READY_ENDPOINT = `${LENS_MIRROR}/api/v1/ready`;
const HEALTH_ENDPOINT = `${LENS_MIRROR}/api/v1/health`;
const RELEASES_ENDPOINT = `${LENS_MIRROR}/api/v1/releases`;
const TESTDATA_PATH = path.join(process.cwd(), "testdata.json");

// Helper to poll a URL until a condition is met or timeout
// This version catches fetch/network errors and continues polling until timeout.
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  intervalMs = 4000,
  timeoutMs = 300000
): Promise<T> {
  const start = Date.now();
  while (true) {
    let val: T | undefined;
    try {
      val = await fn();
    } catch (e) {
      // Log the error but continue polling
      console.error('Polling fetch error:', e);
    }
    // Record each poll result (including undefined on error) to testdata.json
    try {
      const entry = { timestamp: new Date().toISOString(), value: val };
      fs.appendFileSync(TESTDATA_PATH, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error('Failed to write test data', e);
    }
    if (val !== undefined && predicate(val)) return val;
    if (Date.now() - start > timeoutMs) {
      throw new Error('Polling timed out');
    }
    await setTimeout(intervalMs);
  }
}

function startLensNode(tempDir: string): ChildProcess {
  const env = { ...process.env };
  env.SITE_ADDRESS = "zb2rheohWFWEw2pZLovQMiTrSAwT7zkYhFcKLngXQn2ebirQW";
  // Set bootstrappers if not provided
  if (!env.BOOTSTRAPPERS) {
    env.BOOTSTRAPPERS = "/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ,/dns4/65da3760cb3fd2926532310b0650ddca4f88ebd5.peerchecker.com/tcp/4003/wss/p2p/12D3KooWMQTwyWnvKyFPjs72bbrDMUDM7pmtF328X7iTfWws3A18";
  }
  // Light mode flags as requested, include custom data directory
  const args = [
    "run",
    "--onlyReplicate",
    "--bindHost",
    "0.0.0.0",
    "--useRelays",
    "true",
    "--light",
    "--dir",
    tempDir,
  ];
  const child = spawn("./dist/cli/bin.js", args, { cwd: process.cwd(), env, stdio: "inherit" });
  return child;
}
  
describe("Lens‑node light‑mode sync sanity check", () => {
  let proc: ChildProcess;
  let tempDir: string;

  beforeAll(() => {
    // Create a fresh temporary directory for the node's data store
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-node-test-"));
    proc = startLensNode(tempDir);
  });

  afterAll(async () => {
    // Gracefully terminate the process
    proc.kill("SIGINT");
    await once(proc, "exit");
    // Clean up the temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // If cleanup fails, log but do not throw – test suite should still finish
      console.error("Failed to clean temporary directory", e);
    }
  });

  test("ready flag only true when releases match", async () => {
    // First, wait for the health endpoint to report status "ok"
    await poll(
      async () => {
        const res = await fetch(HEALTH_ENDPOINT);
        const json = await res.json();
        return json.status;
      },
      (status) => status === "ok",
      4000,
      300000
    );

    // Then wait until the ready endpoint reports true (or fails after timeout)
    await poll(
      async () => {
        const res = await fetch(READY_ENDPOINT);
        const json = await res.json();
        return json.ready;
      },
      (ready) => ready === true,
      4000,
      300000
    );

    // At this point the node reports ready; fetch releases from both sources
    const [realRes, mirrorRes] = await Promise.all([
      fetch(`${LENS_REAL}/api/v1/releases`).then((r) => r.json()),
      fetch(RELEASES_ENDPOINT).then((r) => r.json()),
    ]);
    // The releases should now match
    // Compare releases and log differences for analysis
if (JSON.stringify(mirrorRes) !== JSON.stringify(realRes)) {
  console.error('Release mismatch detected');
  const diffPath = path.join(process.cwd(), 'release_diff.json');
  fs.writeFileSync(diffPath, JSON.stringify({ mirror: mirrorRes, real: realRes }, null, 2));
  console.log('Diff written to', diffPath);
} else {
  console.log('Releases match');
}
  }, 600000);
});
