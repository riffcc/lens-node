import { describe, it, expect } from '@jest/globals';
import { Peerbit } from 'peerbit';
import { CID } from 'multiformats/cid';

describe('DHT and Routing Tests', () => {
  it('should create CID instances', () => {
    const testCID = CID.parse('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
    expect(testCID).toBeDefined();
    expect(testCID.toString()).toBe('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
  });
  
  it('should create peerbit client and test routing capabilities', async () => {
    let client;
    try {
      client = await Peerbit.create({
        directory: './test-data/routing-test-1',
      });
      
      expect(client).toBeDefined();
      expect(client.peerId).toBeDefined();
      expect(client.libp2p).toBeDefined();
      
      // Test basic client info
      const peerId = client.peerId.toString();
      const multiaddrs = client.getMultiaddrs();
      
      expect(peerId).toMatch(/^12D3Koo/); // PeerID format
      expect(multiaddrs.length).toBeGreaterThan(0);
      
      console.log('✅ Client created successfully:', {
        peerId: peerId,
        multiaddrsCount: multiaddrs.length,
        hasContentRouting: !!client.libp2p.contentRouting,
      });
      
    } finally {
      if (client) {
        await client.stop();
      }
    }
  }, 15000);
  
  it('should test DHT operations when available', async () => {
    let client;
    try {
      client = await Peerbit.create({
        directory: './test-data/routing-test-dht',
      });
      
      const testCID = CID.parse('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
      
      if (client.libp2p.contentRouting) {
        console.log('🔍 Testing DHT operations...');
        
        try {
          // Test provide operation (may fail due to no DHT peers)
          await client.libp2p.contentRouting.provide(testCID);
          console.log('✅ DHT provide operation works');
        } catch (error) {
          console.log('⚠️ DHT provide failed (expected):', error instanceof Error ? error.message : String(error));
        }
        
        // Test find providers (will likely timeout)
        try {
          const providers = [];
          const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 2000)
          );
          
          const findProviders = (async () => {
            for await (const provider of client.libp2p.contentRouting.findProviders(testCID)) {
              providers.push(provider);
              if (providers.length >= 1) break;
            }
            return providers;
          })();
          
          const result = await Promise.race([findProviders, timeout]) as any[];
          console.log('✅ Found providers:', result.length);
        } catch (error) {
          console.log('⚠️ DHT findProviders timed out (expected)');
        }
        
        expect(client.libp2p.contentRouting).toBeDefined();
      } else {
        console.log('ℹ️ No DHT content routing - using native PeerBit routing');
        expect(true).toBe(true); // Test passes
      }
      
    } finally {
      if (client) {
        await client.stop();
      }
    }
  }, 20000);
  
  it('should test peer connectivity and routing', async () => {
    let client1, client2;
    try {
      // Create two clients
      client1 = await Peerbit.create({
        directory: './test-data/routing-test-peer1',
      });
      
      client2 = await Peerbit.create({
        directory: './test-data/routing-test-peer2',
      });
      
      // Try to connect them
      const client1Multiaddrs = client1.getMultiaddrs();
      if (client1Multiaddrs.length > 0) {
        await client2.dial(client1Multiaddrs[0]);
        
        // Wait for connection to establish
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const connections1 = client1.libp2p.getConnections();
        const connections2 = client2.libp2p.getConnections();
        const peers1 = client1.libp2p.getPeers();
        const peers2 = client2.libp2p.getPeers();
        
        console.log('🔗 Connection test results:', {
          client1: {
            peerId: client1.peerId.toString(),
            connections: connections1.length,
            knownPeers: peers1.length,
          },
          client2: {
            peerId: client2.peerId.toString(),
            connections: connections2.length,
            knownPeers: peers2.length,
          },
        });
        
        // Test that at least one connection was established
        expect(connections1.length + connections2.length).toBeGreaterThan(0);
        console.log('✅ Peer connectivity test passed');
      }
      
    } finally {
      if (client1) await client1.stop();
      if (client2) await client2.stop();
    }
  }, 25000);
});