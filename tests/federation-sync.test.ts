import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { Peerbit } from 'peerbit';
import {
  Site,
  LensService,
  RELEASE_NAME_PROPERTY,
  RELEASE_CATEGORY_ID_PROPERTY,
  RELEASE_CONTENT_CID_PROPERTY,
  DEDICATED_SITE_ARGS,
  ADMIN_SITE_ARGS,
} from '@riffcc/lens-sdk';
import { waitFor } from '@peerbit/time';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';

// Mock winston to avoid logging during tests
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    printf: jest.fn(),
    colorize: jest.fn(),
    simple: jest.fn(),
  },
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
  },
}));

describe('Lens Node Federation Synchronization', () => {
  let tempDirs: string[] = [];

  const createTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'lens-node-test-'));
    tempDirs.push(dir);
    return dir;
  };

  const cleanup = async () => {
    for (const dir of tempDirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    tempDirs = [];
  };

  afterAll(async () => {
    await cleanup();
  });

  test('DHT content routing and discovery', async () => {
    let peer1: Peerbit | undefined;
    let peer2: Peerbit | undefined;
    let peer3: Peerbit | undefined;
    let service1: LensService | undefined;
    let service2: LensService | undefined;
    let service3: LensService | undefined;
    let site1: Site | undefined;

    try {
      // Create peers with DHT configuration
      const createPeerWithDHT = async () => {
        return Peerbit.create({
          libp2p: {
            services: {
              dht: {
                enabled: true,
                clientMode: false,
              },
            },
          },
        });
      };

      peer1 = await createPeerWithDHT();
      peer2 = await createPeerWithDHT();
      peer3 = await createPeerWithDHT();

      service1 = new LensService(peer1);
      service2 = new LensService(peer2);
      service3 = new LensService(peer3);

      // Create and open a site
      site1 = new Site(peer1.identity.publicKey);
      await service1.openSite(site1, ADMIN_SITE_ARGS);

      // Add content to site1
      const release1 = await service1.addRelease({
        [RELEASE_NAME_PROPERTY]: 'DHT Discoverable Content',
        [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
        [RELEASE_CONTENT_CID_PROPERTY]: 'QmDHTContent123',
      });

      expect(release1.success).toBe(true);

      // Connect peers in a chain: peer1 <-> peer2 <-> peer3
      await peer2.dial(peer1.getMultiaddrs());
      await peer3.dial(peer2.getMultiaddrs());

      // Peer3 should be able to discover and open site1 through DHT
      // even though it's not directly connected to peer1
      await service3.openSite(site1.address, DEDICATED_SITE_ARGS);

      // Wait for DHT propagation and content discovery
      await waitFor(
        async () => {
          const releases = await service3.getReleases();
          return releases.length > 0;
        },
        { timeout: 30000, delayInterval: 1000 }
      );

      // Verify content was discovered through DHT
      const discoveredRelease = await service3.getRelease({ id: release1.id! });
      expect(discoveredRelease).toBeDefined();
      expect(discoveredRelease?.[RELEASE_NAME_PROPERTY]).toBe('DHT Discoverable Content');

      // Test DHT-based peer discovery
      const peer3Connections = peer3.getConnections();
      expect(peer3Connections.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (service1?.siteProgram) await service1.siteProgram.close();
      if (service2?.siteProgram) await service2.siteProgram.close();
      if (service3?.siteProgram) await service3.siteProgram.close();
      if (site1) await site1.close();
      if (peer1) await peer1.stop();
      if (peer2) await peer2.stop();
      if (peer3) await peer3.stop();
    }
  }, 45000);

  test('gossipsub message propagation', async () => {
    let peers: Peerbit[] = [];
    let services: LensService[] = [];
    let mainSite: Site | undefined;

    try {
      // Create a network of 5 peers
      for (let i = 0; i < 5; i++) {
        const peer = await Peerbit.create({
          libp2p: {
            services: {
              pubsub: {
                enabled: true,
              },
            },
          },
        });
        peers.push(peer);
        services.push(new LensService(peer));
      }

      // Create site on first peer
      mainSite = new Site(peers[0].identity.publicKey);
      await services[0].openSite(mainSite, ADMIN_SITE_ARGS);

      // Connect peers in a partial mesh
      // 0 connects to 1,2
      // 1 connects to 0,3
      // 2 connects to 0,4
      // 3 connects to 1,4
      // 4 connects to 2,3
      await Promise.all([
        peers[1].dial(peers[0].getMultiaddrs()),
        peers[2].dial(peers[0].getMultiaddrs()),
        peers[3].dial(peers[1].getMultiaddrs()),
        peers[4].dial(peers[2].getMultiaddrs()),
        peers[4].dial(peers[3].getMultiaddrs()),
      ]);

      // All peers open the site
      await Promise.all(
        services.slice(1).map(service => 
          service.openSite(mainSite!.address, DEDICATED_SITE_ARGS)
        )
      );

      // Wait for network stabilization
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Add content from peer 0
      const release = await services[0].addRelease({
        [RELEASE_NAME_PROPERTY]: 'Gossipsub Test Release',
        [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
        [RELEASE_CONTENT_CID_PROPERTY]: 'QmGossipsubContent',
      });

      expect(release.success).toBe(true);

      // Content should propagate to all peers via gossipsub
      // even those not directly connected to peer 0
      await waitFor(
        async () => {
          const hasRelease = await Promise.all(
            services.slice(1).map(async service => {
              const r = await service.getRelease({ id: release.id! });
              return r !== undefined;
            })
          );
          return hasRelease.every(has => has === true);
        },
        { timeout: 20000, delayInterval: 500 }
      );

      // Verify all peers received the content
      for (let i = 1; i < services.length; i++) {
        const replicatedRelease = await services[i].getRelease({ id: release.id! });
        expect(replicatedRelease).toBeDefined();
        expect(replicatedRelease?.[RELEASE_NAME_PROPERTY]).toBe('Gossipsub Test Release');
      }
    } finally {
      for (const service of services) {
        if (service.siteProgram) await service.siteProgram.close();
      }
      if (mainSite) await mainSite.close();
      for (const peer of peers) {
        await peer.stop();
      }
    }
  }, 30000);

  test('persistent node recovery and sync', async () => {
    let peer1: Peerbit | undefined;
    let peer2: Peerbit | undefined;
    let service1: LensService | undefined;
    let service2: LensService | undefined;
    let site: Site | undefined;
    const dataDir1 = await createTempDir();
    const dataDir2 = await createTempDir();

    try {
      // Create first peer with persistent storage
      peer1 = await Peerbit.create({
        directory: dataDir1,
      });
      service1 = new LensService(peer1);
      
      site = new Site(peer1.identity.publicKey);
      await service1.openSite(site, ADMIN_SITE_ARGS);

      // Add initial content
      const releases = [];
      for (let i = 0; i < 5; i++) {
        const result = await service1.addRelease({
          [RELEASE_NAME_PROPERTY]: `Persistent Release ${i}`,
          [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
          [RELEASE_CONTENT_CID_PROPERTY]: `QmPersistent${i}`,
        });
        expect(result.success).toBe(true);
        releases.push(result);
      }

      // Create second peer and sync
      peer2 = await Peerbit.create({
        directory: dataDir2,
      });
      service2 = new LensService(peer2);
      
      await peer2.dial(peer1.getMultiaddrs());
      await service2.openSite(site.address, DEDICATED_SITE_ARGS);

      // Wait for initial sync
      await waitFor(
        async () => {
          const syncedReleases = await service2.getReleases();
          return syncedReleases.length === 5;
        },
        { timeout: 20000, delayInterval: 1000 }
      );

      // Simulate peer1 going offline
      await service1.siteProgram?.close();
      await peer1.stop();
      peer1 = undefined;
      service1 = undefined;

      // Add more content while peer1 is offline
      const offlineRelease = await service2.addRelease({
        [RELEASE_NAME_PROPERTY]: 'Added While Peer1 Offline',
        [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
        [RELEASE_CONTENT_CID_PROPERTY]: 'QmOfflineContent',
      });
      expect(offlineRelease.success).toBe(true);

      // Restart peer1
      peer1 = await Peerbit.create({
        directory: dataDir1,
      });
      service1 = new LensService(peer1);
      await service1.openSite(site.address, ADMIN_SITE_ARGS);

      // Reconnect
      await peer1.dial(peer2.getMultiaddrs());

      // Wait for peer1 to sync the new content
      await waitFor(
        async () => {
          const resyncedReleases = await service1.getReleases();
          return resyncedReleases.length === 6;
        },
        { timeout: 20000, delayInterval: 1000 }
      );

      // Verify peer1 has all content including what was added while offline
      const finalReleases = await service1.getReleases();
      expect(finalReleases.length).toBe(6);
      
      const offlineContent = await service1.getRelease({ id: offlineRelease.id! });
      expect(offlineContent).toBeDefined();
      expect(offlineContent?.[RELEASE_NAME_PROPERTY]).toBe('Added While Peer1 Offline');
    } finally {
      if (service1?.siteProgram) await service1.siteProgram.close();
      if (service2?.siteProgram) await service2.siteProgram.close();
      if (site) await site.close();
      if (peer1) await peer1.stop();
      if (peer2) await peer2.stop();
      await cleanup();
    }
  }, 60000);

  test('bootstrap node connectivity and discovery', async () => {
    let bootstrapPeer: Peerbit | undefined;
    let peer1: Peerbit | undefined;
    let peer2: Peerbit | undefined;
    let bootstrapService: LensService | undefined;
    let service1: LensService | undefined;
    let service2: LensService | undefined;
    let site: Site | undefined;

    try {
      // Create bootstrap node
      bootstrapPeer = await Peerbit.create();
      bootstrapService = new LensService(bootstrapPeer);
      
      const bootstrapAddrs = bootstrapPeer.getMultiaddrs();
      
      // Create site on bootstrap
      site = new Site(bootstrapPeer.identity.publicKey);
      await bootstrapService.openSite(site, DEDICATED_SITE_ARGS);

      // Create two peers that only know about the bootstrap
      peer1 = await Peerbit.create();
      peer2 = await Peerbit.create();
      service1 = new LensService(peer1);
      service2 = new LensService(peer2);

      // Both connect only to bootstrap
      await Promise.all([
        peer1.dial(bootstrapAddrs),
        peer2.dial(bootstrapAddrs),
      ]);

      // Both open the same site
      await Promise.all([
        service1.openSite(site.address, ADMIN_SITE_ARGS),
        service2.openSite(site.address, ADMIN_SITE_ARGS),
      ]);

      // Peers should discover each other through the bootstrap
      await waitFor(
        async () => {
          // Check if peer1 and peer2 can see each other's content
          const release1 = await service1.addRelease({
            [RELEASE_NAME_PROPERTY]: 'From Peer1',
            [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
            [RELEASE_CONTENT_CID_PROPERTY]: 'QmFromPeer1',
          });

          if (!release1.success) return false;

          // Wait a bit for propagation
          await new Promise(resolve => setTimeout(resolve, 1000));

          const foundOnPeer2 = await service2.getRelease({ id: release1.id! });
          return foundOnPeer2 !== undefined;
        },
        { timeout: 30000, delayInterval: 2000 }
      );

      // Verify peer discovery worked
      const release2 = await service2.addRelease({
        [RELEASE_NAME_PROPERTY]: 'From Peer2',
        [RELEASE_CATEGORY_ID_PROPERTY]: 'test',
        [RELEASE_CONTENT_CID_PROPERTY]: 'QmFromPeer2',
      });

      expect(release2.success).toBe(true);

      // Peer1 should receive it
      await waitFor(
        async () => {
          const foundOnPeer1 = await service1.getRelease({ id: release2.id! });
          return foundOnPeer1 !== undefined;
        },
        { timeout: 20000, delayInterval: 1000 }
      );
    } finally {
      if (service1?.siteProgram) await service1.siteProgram.close();
      if (service2?.siteProgram) await service2.siteProgram.close();
      if (bootstrapService?.siteProgram) await bootstrapService.siteProgram.close();
      if (site) await site.close();
      if (peer1) await peer1.stop();
      if (peer2) await peer2.stop();
      if (bootstrapPeer) await bootstrapPeer.stop();
    }
  }, 45000);
});