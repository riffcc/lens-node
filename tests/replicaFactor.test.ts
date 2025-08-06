// replicaFactor.test.ts – verifies that the --replicaFactor CLI flag is respected
// The test spawns a lens‑node process with a custom replication factor and checks
// that the process logs the expected replication configuration.

import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

function startLensNodeWithFactor(tempDir: string, factor: number): ChildProcess {
  const env = { ...process.env };
  // Use a known site address (same as other tests)
  env.SITE_ADDRESS = 'zb2rheohWFWEw2pZLovQMiTrSAwT7zkYhFcKLngXQn2ebirQW';
  if (!env.BOOTSTRAPPERS) {
    env.BOOTSTRAPPERS = '/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ,/dns4/65da3760cb3fd2926532310b0650ddca4f88ebd5.peerchecker.com/tcp/4003/wss/p2p/12D3KooWMQTwyWnvKyFPjs72bbrDMUDM7pmtF328X7iTfWws3A18';
  }
  const args = [
    'run',
    '--onlyReplicate',
    '--bindHost',
    '0.0.0.0',
    '--useRelays',
    'true',
    '--dir',
    tempDir,
    '--replicaFactor',
    factor.toString(),
  ];
  // stdio: 'pipe' so we can capture stdout/stderr
  const child = spawn('./dist/cli/bin.js', args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  return child;
}

describe('Lens‑node --replicaFactor flag', () => {
  let proc: ChildProcess;
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-node-replica-'));
    proc = startLensNodeWithFactor(tempDir, 2);
  });

  afterAll(async () => {
    proc.kill('SIGINT');
    await once(proc, 'exit');
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('logs replication config with factor 2', async () => {
    // Wait for a line that contains "Replication config" and the factor value
    const stdout = proc.stdout as NodeJS.ReadableStream;
    const data: Buffer[] = [];
    const timeout = setTimeout(() => {
      throw new Error('Timeout waiting for replication config log');
    }, 300000); // 5 min max

    for await (const chunk of stdout) {
      data.push(chunk as Buffer);
      const text = Buffer.concat(data).toString();
      if (/Replication config.*"factor":\s*2/.test(text)) {
        clearTimeout(timeout);
        return; // test passes
      }
    }
    clearTimeout(timeout);
    throw new Error('Did not find expected replication config in logs');
  }, 600000);
});
