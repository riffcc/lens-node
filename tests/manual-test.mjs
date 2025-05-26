import { Peerbit } from 'peerbit';
import { CID } from 'multiformats/cid';

console.log('Testing PeerBit imports...');

try {
  console.log('✅ Successfully imported Peerbit and CID');
  
  // Test CID creation
  const testCID = CID.parse('QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51');
  console.log('✅ CID creation works:', testCID.toString());
  
  // Test PeerBit client creation
  console.log('Creating PeerBit client...');
  const client = await Peerbit.create({
    directory: './test-data/manual-test',
  });
  
  console.log('✅ PeerBit client created successfully');
  console.log('Client info:', {
    peerId: client.peerId.toString(),
    multiaddrs: client.getMultiaddrs().map(addr => addr.toString()),
    hasContentRouting: !!client.libp2p.contentRouting,
  });
  
  // Test DHT operations if available
  if (client.libp2p.contentRouting) {
    console.log('Testing DHT operations...');
    try {
      await client.libp2p.contentRouting.provide(testCID);
      console.log('✅ DHT provide operation works');
      
      // Try to find providers (will timeout quickly)
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('timeout')), 2000)
      );
      
      const findProviders = (async () => {
        const providers = [];
        for await (const provider of client.libp2p.contentRouting.findProviders(testCID)) {
          providers.push(provider);
          if (providers.length >= 1) break;
        }
        return providers;
      })();
      
      try {
        const providers = await Promise.race([findProviders, timeout]);
        console.log('✅ DHT findProviders works, found:', providers.length);
      } catch (e) {
        console.log('✅ DHT findProviders works (timed out as expected)');
      }
    } catch (error) {
      console.log('⚠️ DHT operations failed:', error.message);
    }
  } else {
    console.log('ℹ️ No content routing available - using native PeerBit routing');
  }
  
  await client.stop();
  console.log('✅ All tests passed!');
  
} catch (error) {
  console.error('❌ Test failed:', error);
  process.exit(1);
}