# Peer Sync Phase 3

This phase replaces Docker-host blob storage with metadata-only coordination and desktop-to-desktop transport.

## Target Outcome

- The Docker web app keeps:
  - authentication
  - quota policy
  - device registry
  - encrypted metadata
  - peer discovery
  - recovery and key management
- The Docker server does not keep vault file blobs.
- Desktop clients hold encrypted blocks locally and exchange them directly.
- Shared-folder files can be seeded by multiple peers.
- User-vault redundancy uses the reserved 5GB raid slice.

## Required Architecture

### 1. Metadata-only server

The API keeps only:

- user accounts
- wrapped vault keys
- file tree metadata
- content hashes
- block manifests
- device online status
- peer availability
- torrent or swarm tickets
- raid placement metadata

The API must stop writing file payloads to MinIO in this phase.

### 2. Desktop block store

Each desktop client stores:

- encrypted block cache
- manifest state
- active torrents or swarm sessions
- peer certificates or session tokens
- raid shard ownership

### 3. Transport

Peer transport must support:

- same-user desktop-to-desktop sync
- shared-folder multi-peer seeding
- resumable large-file transfers
- sparse block fetch
- VPN/LAN routable peers for this phase
- NAT traversal fallback through local relay only if explicitly enabled in a later phase

### 4. Raid reserve

The reserved 5GB is used for:

- parity blocks
- mirrored encrypted shards
- repair jobs when a peer disappears

The server stores shard placement metadata only. It must not store shard payloads.

## Desktop behavior required for this phase

- Always-running sync daemon
- Windows startup registration
- close-to-background behavior
- live transfer progress
- push-only and two-way modes
- manual peer push action
- offline queue with retry
- peer health view

## Protocol changes still required

- peer certificates or stronger device identity
- swarm scheduling beyond simple multi-source piece selection
- desktop block push service
- NAT traversal or relay mode if VPN/LAN routing is not available

## Current repo status

What is already ready:

- desktop background loop
- desktop startup option
- desktop visible transfer progress
- push-only mode
- web auth and key recovery controls
- peer endpoint registration and signed peer tickets
- full-file peer fetch
- piece/block manifests in `sync_peer_pieces`
- per-piece hash validation and resume from verified local part files
- RAID metadata, shard assignment, host confirmation, repair status, and quorum recovery for the implemented 2 data + 1 parity model
- admin RAID and backup menus

What still limits true torrent-style sync:

- only LAN/VPN routable peers are supported
- no DHT/tracker swarm scheduling beyond Docker-brokered discovery
- no NAT traversal
- no Android peer client yet
- legacy MinIO blob APIs remain for non-peer mode and old web flows, but desktop peer mode rejects Docker blob upload
