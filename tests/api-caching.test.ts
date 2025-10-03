// api-caching.test.ts - verifies API can serve queries even when not storing data locally
import { spawn, ChildProcess } from "child_process";
import fetch from "node-fetch";
import fs from "fs";
import os from "os";
import path from "path";
import { setTimeout } from "timers/promises";
import { setTimeout as setTimeoutCb } from "timers";

const LENS_MIRROR = "http://localhost:5003"; // Use different port to avoid conflicts
const RELEASES_ENDPOINT = `${LENS_MIRROR}/api/v1/releases`;
const CATEGORIES_ENDPOINT = `${LENS_MIRROR}/api/v1/content-categories`;
const READY_ENDPOINT = `${LENS_MIRROR}/api/v1/ready`;

// Helper to poll until condition is met
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  intervalMs = 2000,
  timeoutMs = 60000
): Promise<T> {
  const start = Date.now();
  while (true) {
    let val: T | undefined;
    try {
      val = await fn();
    } catch (e) {
      // Continue polling on errors
      console.log('Polling error, continuing...', e);
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
  if (!env.BOOTSTRAPPERS) {
    env.BOOTSTRAPPERS = "/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ";
  }
  
  const args = [
    "run",
    "--onlyReplicate",
    "--bindHost", "0.0.0.0",
    "--useRelays", "true", 
    "--light",
    "--dir", tempDir
  ];
  
  // Override the port to avoid conflicts
  const child = spawn("./dist/cli/bin.js", args, { 
    cwd: process.cwd(), 
    env: { ...env, PORT: "5003" }, 
    stdio: "inherit" 
  });
  return child;
}

describe("API Caching Behavior", () => {
  let proc: ChildProcess;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-api-cache-test-"));
    proc = startLensNode(tempDir);
    
    // Wait for the API to be available
    await setTimeout(5000);
  });

  afterAll(async () => {
    if (proc) {
      proc.kill("SIGINT");
      try {
        await new Promise((resolve) => {
          proc.on('exit', resolve);
          setTimeoutCb(() => resolve(undefined), 5000); // Force timeout after 5s
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

  test("API should serve releases data even with dynamic replication", async () => {
    // Light nodes use dynamic replication, so they might not store everything locally
    // But the API should still be able to serve data by querying the network
    
    const response = await poll(
      () => fetch(RELEASES_ENDPOINT).then(r => r.json()),
      (data: any) => Array.isArray(data) && data.length > 0,
      5000,
      120000
    );

    expect(Array.isArray(response)).toBe(true);
    expect(response.length).toBeGreaterThan(0);
    
    // Verify each release has the expected structure
    response.forEach((release: any) => {
      expect(release).toHaveProperty('id');
      expect(release).toHaveProperty('name');
      expect(release).toHaveProperty('categoryId');
      expect(release).toHaveProperty('category'); // Should be enhanced with category info
    });
  }, 180000);

  test("API should provide category fallbacks when categories aren't locally stored", async () => {
    const response = await fetch(RELEASES_ENDPOINT);
    const releases = await response.json();
    
    expect(Array.isArray(releases)).toBe(true);
    
    if (releases.length > 0) {
      const firstRelease = releases[0];
      expect(firstRelease).toHaveProperty('category');
      
      // Category should either be the full object or a fallback with the ID
      const category = firstRelease.category;
      expect(category).toHaveProperty('categoryId');
      expect(category).toHaveProperty('displayName');
      
      // If it's a fallback, displayName should match categoryId
      // If it's real category data, displayName should be more descriptive
      expect(typeof category.displayName).toBe('string');
    }
  });

  test("API should serve categories even with minimal local storage", async () => {
    const response = await poll(
      () => fetch(CATEGORIES_ENDPOINT).then(r => r.json()),
      (data: any) => Array.isArray(data),
      3000,
      60000
    );

    expect(Array.isArray(response)).toBe(true);
    
    if (response.length > 0) {
      response.forEach((category: any) => {
        expect(category).toHaveProperty('id');
        expect(category).toHaveProperty('categoryId');
        expect(category).toHaveProperty('displayName');
      });
    }
  }, 90000);
});