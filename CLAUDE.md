# CLAUDE.md

## CRITICAL: Ready Endpoint Requirements

**THE `/ready` ENDPOINT MUST VERIFY THAT THE NODE HAS SYNCED CONTENT.**

A "ready" check is NOT just "is the service alive". It means:
- The node has connected to peers
- Content replication has occurred
- Data stores contain replicated content
- The node is actually serving the content it should be serving

We care deeply if content is synced. That's the entire point of the ready check.

The challenge is that checking sync status triggers expensive distributed index queries that cause DoS. The solution is to:
1. Cache sync status and only refresh it periodically (not on every `/ready` call)
2. Use the most efficient Peerbit APIs to check replication status
3. Ensure the check completes quickly without exhausting system resources

But the check MUST verify actual content replication, not just peer connectivity.

## CRITICAL: Local Build vs Docker - It Works Locally

**THE LOCAL BUILD WORKS RELIABLY.** When debugging Docker issues:

The site `zb2rhcRzjgGXUxi8PypUJGvk42HXaXQS3VBZ2aYvgAUrDgkZ1` EXISTS and the local build connects, replicates, and runs successfully with these exact parameters:

```bash
rm -r ~/.lens-node/
SITE_ADDRESS=zb2rhcRzjgGXUxi8PypUJGvk42HXaXQS3VBZ2aYvgAUrDgkZ1 \
BOOTSTRAPPERS=/dns4/relay01.eu.riff.cc/tcp/443/wss/p2p/12D3KooWRcsxc5FBG4QU6MoeGmuXi5KbQyYKwZPnkemKV2GZcRvM,/dns4/relay02.us.riff.cc/tcp/443/wss/p2p/12D3KooWGie5X52rmrZ6iDgqrWv8Ecnc3YfUwsopCT6isbVWZHJR,/dns4/relay03.sg.riff.cc/tcp/443/wss/p2p/12D3KooWDDwXRyvibdj1quDsmvmEKPGH2yK2mMEGXonBKc5GPdDh \
./dist/cli/bin.js run -d ~/.lens-node --onlyReplicate --light --useRelays --apiPort 10002 --listenPort 9001
```

Output: `LensService configured.` and the node runs successfully.

If Docker fails with "Failed to load store" but local works, the issue is NOT:
- The site doesn't exist
- The parameters are wrong
- Native modules (if local and Docker both use the same published package)

Look for environment differences: permissions, file paths, network configuration, or Docker-specific issues.

## CRITICAL: Using DeepWiki for Peerbit Research

**DeepWiki is NOT aware of Lens Node specific terminology or implementation details.**

When querying the dao-xyz/peerbit repository via DeepWiki:
- ❌ DO NOT use Lens-specific terms like "Lens node", "Site", "ready check", "featured releases"
- ✅ DO use Peerbit-specific terms like "peer", "SharedLog", "replication", "relay", "DirectStream"
- ❌ DO NOT assume DeepWiki knows about our lens-sdk wrapper or LensService
- ✅ DO ask about core Peerbit concepts like "connectionManager", "DialerOptions", "SeekDelivery"

**Example Queries:**
- ✅ "How does Peerbit handle relay reconnection when relay connections are lost?"
- ❌ "How does Lens handle relay reconnection?"
- ✅ "How does SeekDelivery calculate quorum in Peerbit?"
- ❌ "How does the ready check work with SeekDelivery?"

DeepWiki provides documentation for the **upstream Peerbit library**, not our implementation that wraps it.