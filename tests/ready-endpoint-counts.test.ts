// ready-endpoint-counts.test.ts - verifies /ready endpoint shows full network counts for light nodes
import { spawn, ChildProcess } from "child_process";
import fetch from "node-fetch";
import fs from "fs";
import os from "os";
import path from "path";
import { setTimeout } from "timers/promises";
import { setTimeout as setTimeoutCb, clearTimeout } from "timers";

const LENS_MIRROR = "http://localhost:5004"; // Use different port to avoid conflicts
const READY_ENDPOINT = `${LENS_MIRROR}/api/v1/ready`;
const RELEASES_ENDPOINT = `${LENS_MIRROR}/api/v1/releases`;

// Helper to poll until condition is met
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  intervalMs = 3000,
  timeoutMs = 180000
): Promise<T> {
  const start = Date.now();
  while (true) {
    let val: T | undefined;
    try {
      val = await fn();
    } catch (e) {
      console.log('Polling error, continuing...', (e as Error).message);
    }
    if (val !== undefined && predicate(val)) return val;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Polling timed out after ${timeoutMs}ms`);
    }
    await setTimeout(intervalMs);
  }
}

function startLightLensNode(tempDir: string): ChildProcess {
  const env = { ...process.env };
  env.SITE_ADDRESS = "zb2rheohWFWEw2pZLovQMiTrSAwT7zkYhFcKLngXQn2ebirQW";
  if (!env.BOOTSTRAPPERS) {
    env.BOOTSTRAPPERS = "/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ";
  }
  
  const args = [
    "run",
    "--onlyReplicate",
    "--bindHost", "0.0.0.0",
    "--useRelays", "true", 
    "--light", // This uses replicate: true (dynamic replication)
    "--dir", tempDir
  ];
  
  const child = spawn("./dist/cli/bin.js", args, { 
    cwd: process.cwd(), 
    env: { ...env, PORT: "5004" }, 
    stdio: "inherit" 
  });
  return child;
}

describe("Ready Endpoint Network Counts", () => {
  let proc: ChildProcess;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-ready-counts-test-"));
    proc = startLightLensNode(tempDir);
    
    // Give the node time to start
    await setTimeout(5000);
  });

  afterAll(async () => {
    if (proc) {
      proc.kill("SIGINT");
      try {
        await new Promise((resolve) => {
          proc.on('exit', resolve);
          const timer = setTimeoutCb(() => resolve(undefined), 8000);
          proc.on('exit', () => clearTimeout(timer));
        });
      } catch (e) {
        console.log('Process cleanup timeout, forcing kill');
        proc.kill('SIGKILL');
      }
    }
    
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean temporary directory", e);
    }
  });

  test("light node /ready endpoint should report full network-accessible counts", async () => {
    // Wait for the ready endpoint to be available and report data
    const readyResponse = await poll(
      async () => {
        const res = await fetch(READY_ENDPOINT);
        const json = await res.json();
        return json;
      },
      (data: any) => data.stores && data.stores.length > 0,
      4000,
      300000
    );

    expect(readyResponse).toHaveProperty('stores');
    expect(Array.isArray(readyResponse.stores)).toBe(true);

    // Find the releases store in the response
    const releasesStore = readyResponse.stores.find((store: any) => store.name === 'releases');
    expect(releasesStore).toBeDefined();

    console.log('Ready endpoint releases store:', releasesStore);

    // The key test: even with dynamic replication (replicate: true), 
    // the ready endpoint should report the full network count
    expect(releasesStore.count).toBeGreaterThanOrEqual(30); // Should see most/all releases

    // Verify we can actually fetch releases through the API
    const releasesResponse = await fetch(RELEASES_ENDPOINT);
    const releases = await releasesResponse.json();
    
    expect(Array.isArray(releases)).toBe(true);
    expect(releases.length).toBeGreaterThanOrEqual(30);
    
    // The ready endpoint count should match the actual API count exactly
    expect(releasesStore.count).toBe(releases.length);
    
    // Additional debug info
    if (releasesStore.localCount !== undefined && releasesStore.networkAccessibleCount !== undefined) {
      console.log(`Local count: ${releasesStore.localCount}, Network accessible: ${releasesStore.networkAccessibleCount}`);
      
      // For light nodes, we expect network accessible count to be higher than local
      if (releasesStore.localCount < releasesStore.networkAccessibleCount) {
        console.log('✓ Light node correctly showing higher network count than local storage');
      }
    }
    
  }, 400000); // 400 second timeout for full sync test
});