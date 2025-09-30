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