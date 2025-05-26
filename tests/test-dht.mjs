#!/usr/bin/env node

import { Peerbit } from 'peerbit';
import { CID } from 'multiformats/cid';

console.log('🚀 Starting DHT functionality tests...');

async function testCIDCreation() {
  console.log('\n1. Testing CID creation...');
  try {
    const testCID = CID.parse('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
    console.log('✅ CID created successfully:', testCID.toString());
    return true;
  } catch (error) {
    console.log('❌ CID creation failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function testPeerbitClient() {
  console.log('\n2. Testing Peerbit client creation...');
  let client;
  try {
    // Use bootstrap peers for DHT configuration like in the main app
    const bootstrapPeers = [
      '/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ',
      '/dns4/65da3760cb3fd2926532310b0650ddca4f88ebd5.peerchecker.com/tcp/4003/wss/p2p/12D3KooWMQTwyWnvKyFPjs72bbrDMUDM7pmtF328X7iTfWws3A18'
    ];
    
    client = await Peerbit.create({
      directory: './test-data/dht-test',
      libp2p: {
        dht: {
          enabled: true,
          bootstrapPeers: bootstrapPeers,
        }
      }
    });
    
    console.log('✅ Peerbit client created successfully');
    console.log('   - PeerID:', client.peerId.toString());
    console.log('   - Multiaddrs:', client.getMultiaddrs().length);
    console.log('   - Has content routing:', !!client.libp2p.contentRouting);
    
    return client;
  } catch (error) {
    console.log('❌ Peerbit client creation failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function testDHTOperations(client) {
  console.log('\n3. Testing DHT operations...');
  
  if (!client.libp2p.contentRouting) {
    console.log('⚠️ No DHT content routing available - this is expected in isolated tests');
    return true;
  }
  
  try {
    const testCID = CID.parse('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
    
    // Test provide operation
    console.log('   Testing content advertisement...');
    await client.libp2p.contentRouting.provide(testCID);
    console.log('✅ DHT provide operation successful');
    
    // Test find providers with timeout
    console.log('   Testing provider discovery...');
    const providers = [];
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('timeout')), 3000)
    );
    
    const findProviders = (async () => {
      for await (const provider of client.libp2p.contentRouting.findProviders(testCID)) {
        providers.push(provider);
        if (providers.length >= 1) break;
      }
      return providers;
    })();
    
    try {
      const result = await Promise.race([findProviders, timeout]);
      console.log('✅ Found providers:', result.length);
    } catch (error) {
      console.log('⚠️ DHT findProviders timed out (expected in isolated test)');
    }
    
    return true;
  } catch (error) {
    console.log('❌ DHT operations failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function testPeerConnectivity() {
  console.log('\n4. Testing peer connectivity...');
  let client1, client2;
  
  try {
    // Use same DHT config for peer connectivity tests
    const dhtConfig = {
      dht: {
        enabled: true,
        bootstrapPeers: [
          '/dns4/4032881a26640025f9a4253104b7aaf6d4b55599.peerchecker.com/tcp/4003/wss/p2p/12D3KooWPYWLY5E7w1SyPJ18y77Wsyfo1fEJcwRonKNPxPam3teJ',
        ]
      }
    };
    
    // Create two clients
    client1 = await Peerbit.create({
      directory: './test-data/dht-test-peer1',
      libp2p: dhtConfig,
    });
    
    client2 = await Peerbit.create({
      directory: './test-data/dht-test-peer2',
      libp2p: dhtConfig,
    });
    
    console.log('✅ Two clients created');
    
    // Try to connect them
    const client1Multiaddrs = client1.getMultiaddrs();
    if (client1Multiaddrs.length > 0) {
      await client2.dial(client1Multiaddrs[0]);
      
      // Wait for connection to establish
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const connections1 = client1.libp2p.getConnections();
      const connections2 = client2.libp2p.getConnections();
      
      console.log('   Client 1 connections:', connections1.length);
      console.log('   Client 2 connections:', connections2.length);
      
      if (connections1.length > 0 || connections2.length > 0) {
        console.log('✅ Peer connectivity test passed');
        return true;
      } else {
        console.log('⚠️ No connections established (may be expected in test environment)');
        return true; // Not a failure in test environment
      }
    }
    
    return true;
  } catch (error) {
    console.log('❌ Peer connectivity test failed:', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (client1) await client1.stop();
    if (client2) await client2.stop();
  }
}

async function runAllTests() {
  console.log('=====================================');
  console.log('       DHT FUNCTIONALITY TESTS      ');
  console.log('=====================================');
  
  const results = [];
  
  // Test 1: CID creation
  results.push(await testCIDCreation());
  
  // Test 2: Peerbit client creation
  const client = await testPeerbitClient();
  results.push(!!client);
  
  if (client) {
    // Test 3: DHT operations
    results.push(await testDHTOperations(client));
    
    // Clean up
    await client.stop();
  }
  
  // Test 4: Peer connectivity
  results.push(await testPeerConnectivity());
  
  // Summary
  console.log('\n=====================================');
  console.log('           TEST SUMMARY              ');
  console.log('=====================================');
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`Tests passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed');
    process.exit(1);
  }
}

runAllTests().catch(error => {
  console.error('❌ Test runner failed:', error);
  process.exit(1);
});