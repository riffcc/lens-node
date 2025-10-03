# Lens Node v2 - Bulletproof Replication Rewrite

## Vision
Make lens-node the easiest decentralized database layer for the browser - **ridiculously bulletproof replication**.

## Core Problems to Solve
1. **Replication Stability** - Current lens-node has fragile peer connections (3-peer minimum warnings)
2. **State Synchronization** - Need bulletproof eventual consistency
3. **Offline-first** - Full functionality without network
4. **Browser Compatibility** - Should work seamlessly in any modern browser

## Architecture Goals

### 1. Peerbit Integration (Latest Libraries)
- Upgrade to latest @peerbit/* packages (currently using 4.1.40, check for 5.x+)
- Leverage improved CRDT implementations
- Use enhanced replication protocols

### 2. Bulletproof Replication Strategy
```
┌─────────────────────────────────────────┐
│         Browser Peer (Flagship)         │
│  ┌───────────────────────────────────┐  │
│  │  Local IndexedDB Cache            │  │
│  │  (Offline-first, instant reads)   │  │
│  └───────────────────────────────────┘  │
│              ▲         │                 │
│              │         ▼                 │
│  ┌───────────────────────────────────┐  │
│  │  Replication Manager              │  │
│  │  - Multi-peer sync                │  │
│  │  - Conflict resolution (CRDT)     │  │
│  │  - Delta sync optimization        │  │
│  └───────────────────────────────────┘  │
│              ▲         │                 │
└──────────────┼─────────┼─────────────────┘
               │         │
    ┌──────────┴─────────┴──────────┐
    │    P2P Mesh Network           │
    │  - WebRTC for browser-browser │
    │  - WebSocket for relay        │
    │  - Auto-discovery             │
    └──────────────────────────────┬┘
                  │
      ┌───────────┴───────────┬───────────┐
      ▼                       ▼           ▼
┌─────────┐            ┌─────────┐   ┌─────────┐
│ Relay 1 │            │ Relay 2 │   │ Relay N │
│ (Lens)  │            │ (Lens)  │   │ (Lens)  │
└─────────┘            └─────────┘   └─────────┘
```

### 3. Replication Guarantees
- **Write Durability**: At least 2 replicas before acknowledging write
- **Read Availability**: Serve from local cache immediately, sync in background
- **Conflict Resolution**: Last-write-wins with vector clocks
- **Partition Tolerance**: Graceful degradation when disconnected

### 4. Performance Targets
- **Cold start**: < 500ms to first render (from cache)
- **Sync latency**: < 100ms for local network peers
- **Bandwidth**: Delta sync only (not full catalog retransmission)
- **Storage**: Efficient IndexedDB with automatic pruning

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Upgrade all @peerbit dependencies to latest
- [ ] Create new replication manager architecture
- [ ] Implement local-first IndexedDB layer
- [ ] Write comprehensive unit tests

### Phase 2: P2P Mesh (Week 2)
- [ ] Multi-peer connection management
- [ ] Automatic relay discovery
- [ ] WebRTC browser-to-browser connections
- [ ] Connection health monitoring

### Phase 3: Bulletproof Sync (Week 3)
- [ ] CRDT-based conflict resolution
- [ ] Delta sync protocol
- [ ] Write-ahead log for durability
- [ ] Recovery from network partitions

### Phase 4: Testing & Optimization (Week 4)
- [ ] Chaos testing (random disconnects, delays)
- [ ] Load testing (1000+ concurrent peers)
- [ ] Browser compatibility testing
- [ ] Performance profiling & optimization

## Success Metrics
- **Zero data loss** in chaos testing
- **< 1% failed writes** under normal conditions
- **99.9% read availability** (from cache)
- **Auto-recovery** from any network partition in < 5 seconds

## Migration Strategy
1. Run v1 and v2 side-by-side
2. Gradual rollout to test users
3. Data compatibility layer for smooth transition
4. Fallback to v1 if issues detected

## Notes
- Focus on **simplicity** - bulletproof doesn't mean complex
- Heavy emphasis on **testing** - this is infrastructure
- **Document everything** - make it easy for others to use
