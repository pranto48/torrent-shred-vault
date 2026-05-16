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
- NAT traversal fallback through local relay only if explicitly enabled

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

- block manifest API
- peer announce API
- peer ticket API
- desktop block fetch service
- desktop block push service
- raid repair coordinator

## Current repo status

The current repo is not on this phase yet.

What is already ready:

- desktop background loop
- desktop startup option
- desktop visible transfer progress
- push-only mode
- web auth and key recovery controls

What still blocks true peer sync:

- server still stores encrypted file blobs
- no peer block transport
- no raid shard engine
- no quorum or repair workflow
