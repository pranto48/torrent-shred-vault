mod watcher;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WindowEvent};
use uuid::Uuid;

const SERVICE_NAME: &str = "torrent-shred-vault-desktop";
const SETTINGS_TRUE: &str = "true";
const DEFAULT_PEER_PORT: u16 = 44888;
const PEER_LISTENER_POLL_MS: u64 = 500;
const DEFAULT_RAID_DATA_SHARDS: usize = 2;
const DEFAULT_RAID_PARITY_SHARDS: usize = 1;
const DEFAULT_RAID_TOTAL_SHARDS: usize = DEFAULT_RAID_DATA_SHARDS + DEFAULT_RAID_PARITY_SHARDS;
const DEFAULT_RAID_QUORUM: usize = 2;
const DEFAULT_RAID_RESERVE_BYTES: i64 = 5 * 1024 * 1024 * 1024;

fn default_transport_mode() -> String {
    "server".to_string()
}

fn default_peer_port() -> u16 {
    DEFAULT_PEER_PORT
}

fn default_raid_data_shards() -> usize {
    DEFAULT_RAID_DATA_SHARDS
}

fn default_raid_parity_shards() -> usize {
    DEFAULT_RAID_PARITY_SHARDS
}

fn default_raid_quorum() -> usize {
    DEFAULT_RAID_QUORUM
}

fn default_raid_reserve_bytes() -> i64 {
    DEFAULT_RAID_RESERVE_BYTES
}

pub struct AppState {
    db_path: PathBuf,
    memory_password: Arc<Mutex<Option<String>>>,
    suppressed_paths: Arc<Mutex<HashMap<String, Instant>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeConfig {
    server_url: String,
    token: String,
    user_email: String,
    device_id: String,
    user_vault_id: String,
    share_vault_id: String,
    user_root: PathBuf,
    share_root: PathBuf,
    reserve_root: PathBuf,
    sync_enabled: bool,
    sync_mode: String,
    transport_mode: String,
    peer_endpoint: Option<String>,
    peer_port: u16,
    raid_enabled: bool,
    raid_data_shards: usize,
    raid_parity_shards: usize,
    raid_quorum_shards: usize,
    raid_reserve_bytes: i64,
    remember_password: bool,
    last_cursor: i64,
}

#[derive(Debug, Serialize)]
struct DesktopStatus {
    configured: bool,
    authenticated: bool,
    sync_enabled: bool,
    startup_enabled: bool,
    sync_mode: String,
    transport_mode: String,
    peer_endpoint: Option<String>,
    peer_port: u16,
    server_url: Option<String>,
    user_email: Option<String>,
    base_dir: Option<String>,
    user_root: Option<String>,
    share_root: Option<String>,
    reserve_root: Option<String>,
    remember_password: bool,
    queue_count: i64,
    raid_hosted_shards: i64,
    raid_pending_jobs: i64,
    raid_protected_manifests: i64,
    raid_degraded_manifests: i64,
    recent_activity: Vec<ActivityRecord>,
    conflicts: Vec<ConflictRecord>,
    transfers: Vec<TransferProgressRecord>,
}

#[derive(Debug, Serialize, Clone)]
struct ActivityRecord {
    id: i64,
    level: String,
    message: String,
    created_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct ConflictRecord {
    id: i64,
    root_kind: String,
    relative_path: String,
    message: String,
    created_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct TransferProgressRecord {
    id: i64,
    root_kind: String,
    relative_path: String,
    direction: String,
    phase: String,
    status: String,
    bytes_total: i64,
    bytes_done: i64,
    percent: f64,
    message: Option<String>,
    updated_at: String,
}

#[derive(Debug, Serialize, Default)]
struct SyncSummary {
    uploads: usize,
    downloads: usize,
    deletions: usize,
    folders_created: usize,
    conflicts: usize,
    cursor: i64,
}

#[derive(Debug, Serialize)]
struct LoginResult {
    status: DesktopStatus,
    summary: SyncSummary,
}

#[derive(Debug, Serialize)]
struct UpdateCheckResult {
    current_version: String,
    latest_version: Option<String>,
    has_update: bool,
    html_url: Option<String>,
    asset_url: Option<String>,
    asset_name: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    token: String,
    user: LoginUser,
}

#[derive(Debug, Deserialize)]
struct LoginUser {
    id: String,
    email: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    device: BootstrapDevice,
    cursor: i64,
    #[serde(rename = "transportMode", default = "default_transport_mode")]
    transport_mode: String,
    #[serde(default)]
    peer: PeerBootstrapConfig,
    #[serde(default)]
    raid: RaidBootstrapConfig,
    vaults: Vec<VaultSummary>,
}

#[derive(Debug, Deserialize, Default)]
struct PeerBootstrapConfig {
    #[serde(default, rename = "enabled")]
    _enabled: bool,
    #[serde(rename = "defaultPort", default = "default_peer_port")]
    default_port: u16,
}

#[derive(Debug, Deserialize, Default)]
struct RaidBootstrapConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(rename = "dataShards", default = "default_raid_data_shards")]
    data_shards: usize,
    #[serde(rename = "parityShards", default = "default_raid_parity_shards")]
    parity_shards: usize,
    #[serde(rename = "quorumShards", default = "default_raid_quorum")]
    quorum_shards: usize,
    #[serde(rename = "reserveBytes", default = "default_raid_reserve_bytes")]
    reserve_bytes: i64,
}

#[derive(Debug, Deserialize)]
struct BootstrapDevice {
    device_id: String,
    last_cursor: i64,
}

#[derive(Debug, Deserialize)]
struct VaultSummary {
    id: String,
    r#type: String,
}

#[derive(Debug, Deserialize)]
struct SyncChangesResponse {
    changes: Vec<SyncChange>,
    #[serde(rename = "hasMore")]
    has_more: bool,
    #[serde(rename = "transportMode", default = "default_transport_mode")]
    transport_mode: String,
}

#[derive(Debug, Deserialize, Clone)]
struct SyncChange {
    cursor: i64,
    vault_id: String,
    path: String,
    operation: String,
    revision: i64,
    file_id: Option<String>,
    sha256: Option<String>,
    #[serde(default)]
    peer_sources: Vec<PeerSource>,
    #[serde(default)]
    raid: Option<RaidManifestSummary>,
}

#[derive(Debug, Deserialize, Clone)]
struct PeerSource {
    device_id: String,
    endpoint_url: String,
    size_bytes: i64,
    sha256: Option<String>,
    ticket: String,
}

#[derive(Debug, Deserialize)]
struct PeerValidateResponse {
    ticket: PeerValidatedTicket,
}

#[derive(Debug, Deserialize)]
struct PeerValidatedTicket {
    kind: String,
    #[serde(rename = "manifestId")]
    manifest_id: Option<String>,
    #[serde(rename = "shardId")]
    shard_id: Option<String>,
    #[serde(rename = "shardIndex")]
    shard_index: Option<i64>,
    path: String,
    #[serde(rename = "rootKind")]
    root_kind: String,
    #[serde(rename = "sourceDeviceId")]
    source_device_id: String,
}

#[derive(Debug, Deserialize)]
struct SyncFileRegisterResponse {
    item: SyncRegisteredItem,
}

#[derive(Debug, Deserialize)]
struct SyncRegisteredItem {
    revision: i64,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidManifestSummary {
    manifest_id: String,
    path: String,
    root_kind: String,
    revision: i64,
    size_bytes: i64,
    shard_bytes: i64,
    status: String,
    quorum_count: i64,
    source_device_id: String,
    shards: Vec<RaidShardSource>,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidShardSource {
    shard_id: String,
    shard_index: i64,
    shard_role: String,
    size_bytes: i64,
    sha256: String,
    sources: Vec<RaidPeerShardSource>,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidPeerShardSource {
    device_id: String,
    endpoint_url: String,
    ticket: String,
}

#[derive(Debug, Deserialize)]
struct RaidRegisterResponse {
    raid: Option<RaidManifestSummary>,
}

#[derive(Debug, Deserialize)]
struct RaidAssignmentsResponse {
    assignments: Vec<RaidAssignment>,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidAssignment {
    #[serde(rename = "hostId")]
    host_id: String,
    #[serde(rename = "shardId")]
    shard_id: String,
    #[serde(rename = "shardIndex")]
    shard_index: i64,
    #[serde(rename = "shardRole")]
    shard_role: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
    sha256: String,
    status: String,
    #[serde(rename = "localPath")]
    local_path: Option<String>,
    manifest: RaidAssignmentManifest,
    source: Option<RaidAssignmentSource>,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidAssignmentManifest {
    #[serde(rename = "manifestId")]
    manifest_id: String,
    path: String,
    #[serde(rename = "rootKind")]
    root_kind: String,
    revision: i64,
    #[serde(rename = "fileSizeBytes")]
    file_size_bytes: i64,
}

#[derive(Debug, Deserialize, Clone)]
struct RaidAssignmentSource {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "endpointUrl")]
    endpoint_url: String,
    ticket: String,
}

#[derive(Debug, Deserialize)]
struct RaidStatusResponse {
    #[serde(rename = "reserveBytes")]
    reserve_bytes: i64,
    #[serde(rename = "reserveUsedBytes")]
    reserve_used_bytes: i64,
    manifests: Vec<RaidManifestSummary>,
}

#[derive(Debug, Serialize)]
struct RaidUploadShard {
    index: i64,
    role: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: i64,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug)]
struct QueueItem {
    id: i64,
    root_kind: String,
    relative_path: String,
    operation: String,
}

impl AppState {
    fn new() -> Result<Self> {
        let data_dir = app_data_dir()?;
        fs::create_dir_all(&data_dir).context("failed to create app data directory")?;
        let db_path = data_dir.join("desktop.db");
        let state = Self {
            db_path,
            memory_password: Arc::new(Mutex::new(None)),
            suppressed_paths: Arc::new(Mutex::new(HashMap::new())),
        };
        let conn = state.connect()?;
        initialize_schema(&conn)?;
        Ok(state)
    }

    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path).context("failed to open desktop database")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }
}

fn app_data_dir() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .ok_or_else(|| anyhow!("unable to resolve local app data directory"))?
        .join("TorrentShredVaultDesktop"))
}

fn default_base_dir() -> Result<PathBuf> {
    let docs = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| anyhow!("unable to resolve documents directory"))?;
    Ok(docs.join("Torrent Shred Vault"))
}

fn initialize_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_kind TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(root_kind, relative_path)
        );

        CREATE TABLE IF NOT EXISTS sync_state (
          root_kind TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          content_hash TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          sync_state TEXT NOT NULL DEFAULT 'synced',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (root_kind, relative_path)
        );

        CREATE TABLE IF NOT EXISTS conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_kind TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS activity_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS transfer_progress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_kind TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          direction TEXT NOT NULL,
          phase TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          bytes_total INTEGER NOT NULL DEFAULT 0,
          bytes_done INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(root_kind, relative_path, direction)
        );

        CREATE TABLE IF NOT EXISTS raid_local_shards (
          shard_id TEXT PRIMARY KEY,
          host_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          root_kind TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          revision INTEGER NOT NULL,
          shard_index INTEGER NOT NULL,
          shard_role TEXT NOT NULL,
          local_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'available',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS raid_status_cache (
          manifest_id TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL,
          status TEXT NOT NULL,
          quorum_count INTEGER NOT NULL DEFAULT 0,
          shard_count INTEGER NOT NULL DEFAULT 0,
          reserve_bytes INTEGER NOT NULL DEFAULT 0,
          reserve_used_bytes INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        "#,
    )?;
    Ok(())
}

fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()?)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn delete_setting(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

fn get_bool_setting(conn: &Connection, key: &str) -> Result<bool> {
    Ok(get_setting(conn, key)?.as_deref() == Some(SETTINGS_TRUE))
}

fn set_bool_setting(conn: &Connection, key: &str, value: bool) -> Result<()> {
    set_setting(conn, key, if value { SETTINGS_TRUE } else { "false" })
}

fn get_sync_mode(conn: &Connection) -> Result<String> {
    Ok(match get_setting(conn, "sync_mode")?.as_deref() {
        Some("push_only") => "push_only".to_string(),
        _ => "two_way".to_string(),
    })
}

fn set_sync_mode_setting(conn: &Connection, mode: &str) -> Result<()> {
    let normalized = if mode == "push_only" { "push_only" } else { "two_way" };
    set_setting(conn, "sync_mode", normalized)
}

fn get_transport_mode(conn: &Connection) -> Result<String> {
    Ok(match get_setting(conn, "transport_mode")?.as_deref() {
        Some("peer") => "peer".to_string(),
        _ => "server".to_string(),
    })
}

fn set_transport_mode_setting(conn: &Connection, mode: &str) -> Result<()> {
    let normalized = if mode == "peer" { "peer" } else { "server" };
    set_setting(conn, "transport_mode", normalized)
}

fn get_peer_port(conn: &Connection) -> Result<u16> {
    Ok(get_setting(conn, "peer_port")?
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PEER_PORT))
}

fn normalize_server_url(value: &str) -> String {
    let mut trimmed = value.trim().replace('\\', "/");
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        trimmed = format!("http://{trimmed}");
    }
    if let Some(hash_index) = trimmed.find('#') {
        trimmed.truncate(hash_index);
    }
    while trimmed.ends_with('/') {
        trimmed.pop();
    }
    if trimmed.ends_with("/api") {
        trimmed.truncate(trimmed.len() - 4);
    }
    trimmed
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "windows-desktop".to_string())
}

fn normalize_relative_path(path: &Path) -> Result<String> {
    let text = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().replace('\\', "/"))
        .filter(|component| !component.is_empty() && component != ".")
        .collect::<Vec<_>>();
    if text.is_empty() {
        return Ok("/".to_string());
    }
    Ok(format!("/{}", text.join("/")))
}

fn split_relative_path(relative_path: &str) -> Result<(String, String)> {
    let trimmed = relative_path.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("relative path cannot point to root"));
    }
    let mut parts = trimmed.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
    let name = parts.pop().ok_or_else(|| anyhow!("missing file name"))?.to_string();
    let parent = if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    };
    Ok((parent, name))
}

fn join_root_path(root: &Path, relative_path: &str) -> PathBuf {
    let mut current = root.to_path_buf();
    for segment in relative_path.trim_matches('/').split('/') {
        if !segment.is_empty() {
            current.push(segment);
        }
    }
    current
}

fn queue_local_event(state: &AppState, root_kind: &str, relative_path: &str, operation: &str) -> Result<()> {
    if relative_path == "/" {
        return Ok(());
    }
    let conn = state.connect()?;
    conn.execute(
        r#"
        INSERT INTO sync_queue (root_kind, relative_path, operation, status, error, attempts, updated_at)
        VALUES (?1, ?2, ?3, 'queued', NULL, 0, CURRENT_TIMESTAMP)
        ON CONFLICT(root_kind, relative_path) DO UPDATE SET
          operation = excluded.operation,
          status = 'queued',
          error = NULL,
          updated_at = CURRENT_TIMESTAMP
        "#,
        params![root_kind, relative_path, operation],
    )?;
    Ok(())
}

pub(crate) fn log_activity(state: &AppState, level: &str, message: &str) -> Result<()> {
    let conn = state.connect()?;
    conn.execute(
        "INSERT INTO activity_log (level, message) VALUES (?1, ?2)",
        params![level, message],
    )?;
    Ok(())
}

fn add_conflict(state: &AppState, root_kind: &str, relative_path: &str, message: &str) -> Result<()> {
    let conn = state.connect()?;
    conn.execute(
        "INSERT INTO conflicts (root_kind, relative_path, message) VALUES (?1, ?2, ?3)",
        params![root_kind, relative_path, message],
    )?;
    Ok(())
}

fn suppress_path(state: &AppState, path: &Path) {
    if let Ok(mut suppressed) = state.suppressed_paths.lock() {
        suppressed.insert(path.to_string_lossy().to_lowercase(), Instant::now() + Duration::from_secs(10));
    }
}

pub(crate) fn is_suppressed(state: &AppState, path: &Path) -> bool {
    let key = path.to_string_lossy().to_lowercase();
    let now = Instant::now();
    if let Ok(mut suppressed) = state.suppressed_paths.lock() {
        suppressed.retain(|_, until| *until > now);
        suppressed.get(&key).is_some()
    } else {
        false
    }
}

fn current_status(state: &AppState) -> Result<DesktopStatus> {
    let conn = state.connect()?;
    let configured = get_setting(&conn, "server_url")?.is_some();
    let authenticated = get_setting(&conn, "auth_token")?.is_some();
    let server_url = get_setting(&conn, "server_url")?;
    let user_email = get_setting(&conn, "user_email")?;
    let base_dir = get_setting(&conn, "base_dir")?;
    let user_root = get_setting(&conn, "user_root")?;
    let share_root = get_setting(&conn, "share_root")?;
    let reserve_root = get_setting(&conn, "reserve_root")?;
    let sync_enabled = get_bool_setting(&conn, "sync_enabled")?;
    let sync_mode = get_sync_mode(&conn)?;
    let transport_mode = get_transport_mode(&conn)?;
    let peer_endpoint = get_setting(&conn, "peer_endpoint")?;
    let peer_port = get_peer_port(&conn)?;
    let remember_password = get_bool_setting(&conn, "remember_password")?;
    let startup_enabled = is_startup_enabled();
    let queue_count = conn.query_row("SELECT COUNT(*) FROM sync_queue WHERE status IN ('queued', 'failed', 'syncing')", [], |row| row.get(0))?;
    let raid_hosted_shards = conn.query_row("SELECT COUNT(*) FROM raid_local_shards WHERE status = 'available'", [], |row| row.get(0))?;
    let raid_pending_jobs = conn.query_row("SELECT COUNT(*) FROM raid_local_shards WHERE status IN ('assigned', 'repairing')", [], |row| row.get(0))?;
    let raid_protected_manifests = conn.query_row("SELECT COUNT(*) FROM raid_status_cache WHERE status = 'protected'", [], |row| row.get(0))?;
    let raid_degraded_manifests = conn.query_row("SELECT COUNT(*) FROM raid_status_cache WHERE status IN ('pending', 'degraded', 'repairing')", [], |row| row.get(0))?;

    let recent_activity = {
        let mut stmt = conn.prepare(
            "SELECT id, level, message, created_at FROM activity_log ORDER BY id DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ActivityRecord {
                id: row.get(0)?,
                level: row.get(1)?,
                message: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let conflicts = {
        let mut stmt = conn.prepare(
            "SELECT id, root_kind, relative_path, message, created_at FROM conflicts ORDER BY id DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ConflictRecord {
                id: row.get(0)?,
                root_kind: row.get(1)?,
                relative_path: row.get(2)?,
                message: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let transfers = {
        let mut stmt = conn.prepare(
            "SELECT id, root_kind, relative_path, direction, phase, status, bytes_total, bytes_done, message, updated_at FROM transfer_progress ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC LIMIT 12",
        )?;
        let rows = stmt.query_map([], |row| {
            let bytes_total: i64 = row.get(6)?;
            let bytes_done: i64 = row.get(7)?;
            let percent = if bytes_total > 0 {
                (bytes_done as f64 / bytes_total as f64 * 100.0).clamp(0.0, 100.0)
            } else if row.get::<_, String>(5)? == "completed" {
                100.0
            } else {
                0.0
            };
            Ok(TransferProgressRecord {
                id: row.get(0)?,
                root_kind: row.get(1)?,
                relative_path: row.get(2)?,
                direction: row.get(3)?,
                phase: row.get(4)?,
                status: row.get(5)?,
                bytes_total,
                bytes_done,
                percent,
                message: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    Ok(DesktopStatus {
        configured,
        authenticated,
        sync_enabled,
        startup_enabled,
        sync_mode,
        transport_mode,
        peer_endpoint,
        peer_port,
        server_url,
        user_email,
        base_dir,
        user_root,
        share_root,
        reserve_root,
        remember_password,
        queue_count,
        raid_hosted_shards,
        raid_pending_jobs,
        raid_protected_manifests,
        raid_degraded_manifests,
        recent_activity,
        conflicts,
        transfers,
    })
}

fn load_runtime_config(state: &AppState) -> Result<Option<RuntimeConfig>> {
    let conn = state.connect()?;
    let Some(server_url) = get_setting(&conn, "server_url")? else {
        return Ok(None);
    };
    let Some(token) = get_setting(&conn, "auth_token")? else {
        return Ok(None);
    };
    let Some(user_email) = get_setting(&conn, "user_email")? else {
        return Ok(None);
    };
    let Some(device_id) = get_setting(&conn, "device_id")? else {
        return Ok(None);
    };
    let Some(user_vault_id) = get_setting(&conn, "user_vault_id")? else {
        return Ok(None);
    };
    let Some(share_vault_id) = get_setting(&conn, "share_vault_id")? else {
        return Ok(None);
    };
    let Some(user_root) = get_setting(&conn, "user_root")? else {
        return Ok(None);
    };
    let Some(share_root) = get_setting(&conn, "share_root")? else {
        return Ok(None);
    };
    let Some(reserve_root) = get_setting(&conn, "reserve_root")? else {
        return Ok(None);
    };
    let sync_enabled = get_bool_setting(&conn, "sync_enabled")?;
    let sync_mode = get_sync_mode(&conn)?;
    let transport_mode = get_transport_mode(&conn)?;
    let peer_endpoint = get_setting(&conn, "peer_endpoint")?;
    let peer_port = get_peer_port(&conn)?;
    let raid_enabled = get_bool_setting(&conn, "raid_enabled")?;
    let raid_data_shards = get_setting(&conn, "raid_data_shards")?.and_then(|value| value.parse::<usize>().ok()).unwrap_or(DEFAULT_RAID_DATA_SHARDS);
    let raid_parity_shards = get_setting(&conn, "raid_parity_shards")?.and_then(|value| value.parse::<usize>().ok()).unwrap_or(DEFAULT_RAID_PARITY_SHARDS);
    let raid_quorum_shards = get_setting(&conn, "raid_quorum_shards")?.and_then(|value| value.parse::<usize>().ok()).unwrap_or(DEFAULT_RAID_QUORUM);
    let raid_reserve_bytes = get_setting(&conn, "raid_reserve_bytes")?.and_then(|value| value.parse::<i64>().ok()).unwrap_or(DEFAULT_RAID_RESERVE_BYTES);
    let remember_password = get_bool_setting(&conn, "remember_password")?;
    let last_cursor = get_setting(&conn, "last_cursor")?
        .unwrap_or_else(|| "0".to_string())
        .parse::<i64>()
        .unwrap_or(0);

    Ok(Some(RuntimeConfig {
        server_url,
        token,
        user_email,
        device_id,
        user_vault_id,
        share_vault_id,
        user_root: PathBuf::from(user_root),
        share_root: PathBuf::from(share_root),
        reserve_root: PathBuf::from(reserve_root),
        sync_enabled,
        sync_mode,
        transport_mode,
        peer_endpoint,
        peer_port,
        raid_enabled,
        raid_data_shards,
        raid_parity_shards,
        raid_quorum_shards,
        raid_reserve_bytes,
        remember_password,
        last_cursor,
    }))
}

pub(crate) fn runtime_config_for_watch(state: &AppState) -> Option<RuntimeConfig> {
    load_runtime_config(state).ok().flatten()
}

fn auth_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("failed to build HTTP client")
}

fn decode_json<T: DeserializeOwned>(response: reqwest::blocking::Response) -> Result<T> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_else(|_| "request failed".to_string());
        return Err(anyhow!(body));
    }
    response.json::<T>().context("failed to decode response")
}

fn remember_password(state: &AppState, email: &str, password: &str, remember: bool) -> Result<()> {
    if remember {
        let entry = keyring::Entry::new(SERVICE_NAME, email)?;
        entry.set_password(password)?;
        if let Ok(mut in_memory) = state.memory_password.lock() {
            *in_memory = None;
        }
    } else {
        if let Ok(mut in_memory) = state.memory_password.lock() {
            *in_memory = Some(password.to_string());
        }
        if let Ok(entry) = keyring::Entry::new(SERVICE_NAME, email) {
            let _ = entry.delete_credential();
        }
    }
    Ok(())
}

fn load_private_password(state: &AppState, config: &RuntimeConfig) -> Result<Option<String>> {
    if config.remember_password {
        let entry = keyring::Entry::new(SERVICE_NAME, &config.user_email)?;
        Ok(entry.get_password().ok())
    } else {
        Ok(state.memory_password.lock().ok().and_then(|guard| guard.clone()))
    }
}

fn is_startup_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "TorrentShredVaultDesktop",
            ])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn set_startup_enabled_internal(enabled: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let exe = std::env::current_exe().context("failed to locate current desktop executable")?;
            let value = format!("\"{}\"", exe.display());
            let output = std::process::Command::new("reg")
                .args([
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "TorrentShredVaultDesktop",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ])
                .output()
                .context("failed to enable Windows startup")?;
            if !output.status.success() {
                return Err(anyhow!(String::from_utf8_lossy(&output.stderr).to_string()));
            }
        } else {
            let output = std::process::Command::new("reg")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "TorrentShredVaultDesktop",
                    "/f",
                ])
                .output()
                .context("failed to disable Windows startup")?;
            if !output.status.success() && !String::from_utf8_lossy(&output.stderr).contains("unable to find") {
                return Err(anyhow!(String::from_utf8_lossy(&output.stderr).to_string()));
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err(anyhow!("startup registration is only implemented for Windows"))
    }
}

fn set_sync_enabled(state: &AppState, enabled: bool) -> Result<()> {
    let conn = state.connect()?;
    set_bool_setting(&conn, "sync_enabled", enabled)?;
    Ok(())
}

fn save_last_cursor(state: &AppState, cursor: i64) -> Result<()> {
    let conn = state.connect()?;
    set_setting(&conn, "last_cursor", &cursor.to_string())
}

fn detect_peer_endpoint(server_url: &str, peer_port: u16) -> Option<String> {
    let parsed = reqwest::Url::parse(server_url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect((host, port)).ok()?;
    let local = socket.local_addr().ok()?;
    Some(format!("http://{}:{}", local.ip(), peer_port))
}

fn guess_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("txt") => "text/plain",
        Some("json") => "application/json",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("mp4") => "video/mp4",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn hash_file(path: &Path) -> Result<(String, i64)> {
    let mut file = fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut total = 0_i64;
    let mut buffer = vec![0_u8; 262_144];
    loop {
        let read = file.read(&mut buffer).with_context(|| format!("failed to read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as i64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn register_peer_endpoint(state: &AppState, config: &RuntimeConfig) -> Result<Option<String>> {
    if config.transport_mode != "peer" {
        return Ok(None);
    }
    let Some(endpoint_url) = detect_peer_endpoint(&config.server_url, config.peer_port).or_else(|| config.peer_endpoint.clone()) else {
        return Ok(None);
    };
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/peer/register", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "deviceId": config.device_id,
            "endpointUrl": endpoint_url,
            "peerPort": config.peer_port,
            "localRoots": {
                "user_vault": config.user_root.to_string_lossy(),
                "share_vault": config.share_root.to_string_lossy(),
            }
        }))
        .send()
        .context("failed to register peer endpoint")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "peer registration failed".to_string());
        return Err(anyhow!(body));
    }
    let conn = state.connect()?;
    set_setting(&conn, "peer_endpoint", &endpoint_url)?;
    Ok(Some(endpoint_url))
}

fn publish_peer_availability(
    config: &RuntimeConfig,
    root_kind: &str,
    relative_path: &str,
    revision: i64,
    size_bytes: i64,
    sha256: &str,
) -> Result<()> {
    if config.transport_mode != "peer" {
        return Ok(());
    }
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/peer/availability", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "deviceId": config.device_id,
            "rootKind": root_kind,
            "relativePath": relative_path,
            "revision": revision,
            "sizeBytes": size_bytes,
            "sha256": sha256,
            "present": true
        }))
        .send()
        .context("failed to publish peer availability")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "peer availability publish failed".to_string());
        return Err(anyhow!(body));
    }
    Ok(())
}

fn unpublish_peer_availability(config: &RuntimeConfig, root_kind: &str, relative_path: &str) -> Result<()> {
    if config.transport_mode != "peer" {
        return Ok(());
    }
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/peer/availability", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "deviceId": config.device_id,
            "rootKind": root_kind,
            "relativePath": relative_path,
            "sizeBytes": 0,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "present": false
        }))
        .send()
        .context("failed to unpublish peer availability")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "peer availability remove failed".to_string());
        return Err(anyhow!(body));
    }
    Ok(())
}

fn publish_local_catalog(state: &AppState, config: &RuntimeConfig) -> Result<()> {
    if config.transport_mode != "peer" {
        return Ok(());
    }
    let conn = state.connect()?;
    let mut stmt = conn.prepare(
        "SELECT root_kind, relative_path, content_hash, revision FROM sync_state WHERE sync_state = 'synced' AND deleted_at IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (root_kind, relative_path, content_hash, revision) = row?;
        let root = if root_kind == "share_vault" {
            &config.share_root
        } else {
            &config.user_root
        };
        let full_path = join_root_path(root, &relative_path);
        if !full_path.is_file() {
            continue;
        }
        let size_bytes = full_path.metadata().map(|meta| meta.len() as i64).unwrap_or(0);
        let sha256 = if let Some(existing) = content_hash {
            existing
        } else {
            hash_file(&full_path)?.0
        };
        let _ = publish_peer_availability(config, &root_kind, &relative_path, revision, size_bytes, &sha256);
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn build_raid_shard_bytes(file_bytes: &[u8]) -> (i64, Vec<Vec<u8>>, Vec<RaidUploadShard>) {
    let shard_len = file_bytes.len().div_ceil(DEFAULT_RAID_DATA_SHARDS).max(1);
    let mut shard0 = vec![0_u8; shard_len];
    let mut shard1 = vec![0_u8; shard_len];
    let first_len = file_bytes.len().min(shard_len);
    shard0[..first_len].copy_from_slice(&file_bytes[..first_len]);
    if file_bytes.len() > shard_len {
        let second_len = file_bytes.len() - shard_len;
        shard1[..second_len].copy_from_slice(&file_bytes[shard_len..]);
    }
    let parity = shard0
        .iter()
        .zip(shard1.iter())
        .map(|(left, right)| left ^ right)
        .collect::<Vec<_>>();
    let shards = vec![shard0, shard1, parity];
    let manifest = shards
        .iter()
        .enumerate()
        .map(|(index, bytes)| RaidUploadShard {
            index: index as i64,
            role: if index + 1 == DEFAULT_RAID_TOTAL_SHARDS { "parity".to_string() } else { "data".to_string() },
            size_bytes: bytes.len() as i64,
            sha256: hash_bytes(bytes),
        })
        .collect::<Vec<_>>();
    (shard_len as i64, shards, manifest)
}

fn local_raid_shard_path(config: &RuntimeConfig, manifest_id: &str, shard_index: i64) -> PathBuf {
    config
        .reserve_root
        .join(manifest_id)
        .join(format!("shard-{}.bin", shard_index))
}

fn upsert_local_raid_shard(
    state: &AppState,
    assignment: &RaidAssignment,
    local_path: &Path,
    status: &str,
) -> Result<()> {
    let conn = state.connect()?;
    conn.execute(
        r#"
        INSERT INTO raid_local_shards (
          shard_id, host_id, manifest_id, root_kind, relative_path, revision, shard_index, shard_role,
          local_path, size_bytes, sha256, status, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP)
        ON CONFLICT(shard_id) DO UPDATE SET
          host_id = excluded.host_id,
          manifest_id = excluded.manifest_id,
          root_kind = excluded.root_kind,
          relative_path = excluded.relative_path,
          revision = excluded.revision,
          shard_index = excluded.shard_index,
          shard_role = excluded.shard_role,
          local_path = excluded.local_path,
          size_bytes = excluded.size_bytes,
          sha256 = excluded.sha256,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
        "#,
        params![
            assignment.shard_id,
            assignment.host_id,
            assignment.manifest.manifest_id,
            assignment.manifest.root_kind,
            assignment.manifest.path,
            assignment.manifest.revision,
            assignment.shard_index,
            assignment.shard_role,
            local_path.to_string_lossy(),
            assignment.size_bytes,
            assignment.sha256,
            status,
        ],
    )?;
    Ok(())
}

fn cache_raid_status(state: &AppState, payload: &RaidStatusResponse) -> Result<()> {
    let conn = state.connect()?;
    conn.execute("DELETE FROM raid_status_cache", [])?;
    for manifest in &payload.manifests {
        conn.execute(
            "INSERT INTO raid_status_cache (manifest_id, relative_path, status, quorum_count, shard_count, reserve_bytes, reserve_used_bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)",
            params![
                manifest.manifest_id,
                manifest.path,
                manifest.status,
                manifest.quorum_count,
                manifest.shards.len() as i64,
                payload.reserve_bytes,
                payload.reserve_used_bytes,
            ],
        )?;
    }
    Ok(())
}

fn refresh_raid_status_cache(state: &AppState, config: &RuntimeConfig) -> Result<()> {
    if config.transport_mode != "peer" || !config.raid_enabled {
        return Ok(());
    }
    let client = auth_client()?;
    let response = client
        .get(format!("{}/api/sync/raid/status", config.server_url))
        .bearer_auth(&config.token)
        .query(&[("deviceId", config.device_id.clone())])
        .send()
        .context("failed to load RAID status")?;
    let payload: RaidStatusResponse = decode_json(response)?;
    cache_raid_status(state, &payload)
}

fn confirm_raid_host(
    config: &RuntimeConfig,
    assignment: &RaidAssignment,
    local_path: &Path,
    size_bytes: i64,
    sha256: &str,
) -> Result<()> {
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/raid/host/confirm", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "deviceId": config.device_id,
            "hostId": assignment.host_id,
            "manifestId": assignment.manifest.manifest_id,
            "shardId": assignment.shard_id,
            "localPath": local_path.to_string_lossy(),
            "sizeBytes": size_bytes,
            "sha256": sha256,
        }))
        .send()
        .context("failed to confirm RAID shard host")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "raid host confirm failed".to_string());
        return Err(anyhow!(body));
    }
    Ok(())
}

fn cleanup_stale_local_raid_shards(state: &AppState, active_shards: &[String]) -> Result<()> {
    let conn = state.connect()?;
    let mut stmt = conn.prepare("SELECT shard_id, local_path FROM raid_local_shards")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (shard_id, local_path) = row?;
        if active_shards.iter().any(|value| value == &shard_id) {
            continue;
        }
        let path = PathBuf::from(local_path);
        let _ = fs::remove_file(&path);
        conn.execute("DELETE FROM raid_local_shards WHERE shard_id = ?1", [shard_id])?;
    }
    Ok(())
}

fn process_raid_assignments(state: &AppState, config: &RuntimeConfig) -> Result<()> {
    if config.transport_mode != "peer" || !config.raid_enabled {
        return Ok(());
    }
    let client = auth_client()?;
    let response = client
        .get(format!("{}/api/sync/raid/assignments", config.server_url))
        .bearer_auth(&config.token)
        .query(&[("deviceId", config.device_id.clone())])
        .send()
        .context("failed to load RAID assignments")?;
    let payload: RaidAssignmentsResponse = decode_json(response)?;
    let active_shards = payload
        .assignments
        .iter()
        .map(|assignment| assignment.shard_id.clone())
        .collect::<Vec<_>>();

    for assignment in &payload.assignments {
        let local_path = local_raid_shard_path(config, &assignment.manifest.manifest_id, assignment.shard_index);
        if local_path.is_file() {
            let (existing_hash, existing_size) = hash_file(&local_path)?;
            if existing_hash == assignment.sha256 {
                confirm_raid_host(config, assignment, &local_path, existing_size, &existing_hash)?;
                upsert_local_raid_shard(state, assignment, &local_path, "available")?;
                continue;
            }
        }

        let Some(source) = &assignment.source else {
            continue;
        };
        if let Some(parent) = local_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let request_url = reqwest::Url::parse_with_params(
            &format!("{}/peer/raid-shard", source.endpoint_url.trim_end_matches('/')),
            &[("ticket", source.ticket.as_str())],
        )
        .with_context(|| format!("invalid RAID source endpoint {}", source.endpoint_url))?;
        let response = client.get(request_url).send().with_context(|| format!("failed to fetch RAID shard from {}", source.device_id))?;
        if !response.status().is_success() {
            let body = response.text().unwrap_or_else(|_| "raid shard download failed".to_string());
            return Err(anyhow!(body));
        }
        stream_response_to_file(state, &assignment.manifest.root_kind, &assignment.manifest.path, "raid", response, &local_path)?;
        let (stored_hash, stored_size) = hash_file(&local_path)?;
        if stored_hash != assignment.sha256 {
            return Err(anyhow!("downloaded RAID shard hash mismatch for {}", assignment.manifest.path));
        }
        confirm_raid_host(config, assignment, &local_path, stored_size, &stored_hash)?;
        upsert_local_raid_shard(state, assignment, &local_path, "available")?;
    }

    cleanup_stale_local_raid_shards(state, &active_shards)?;
    refresh_raid_status_cache(state, config)?;
    Ok(())
}

fn download_bytes_from_ticket(endpoint_url: &str, ticket: &str) -> Result<Vec<u8>> {
    let client = auth_client()?;
    let request_url = reqwest::Url::parse_with_params(
        &format!("{}/peer/raid-shard", endpoint_url.trim_end_matches('/')),
        &[("ticket", ticket)],
    )
    .with_context(|| format!("invalid RAID endpoint {}", endpoint_url))?;
    let mut response = client.get(request_url).send().context("failed to request RAID shard")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "raid shard request failed".to_string());
        return Err(anyhow!(body));
    }
    let mut buffer = Vec::new();
    response.read_to_end(&mut buffer).context("failed to read RAID shard body")?;
    Ok(buffer)
}

fn xor_bytes(left: &[u8], right: &[u8]) -> Vec<u8> {
    let len = left.len().max(right.len());
    let mut output = vec![0_u8; len];
    for index in 0..len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        output[index] = left_byte ^ right_byte;
    }
    output
}

fn reconstruct_file_from_raid(
    state: &AppState,
    config: &RuntimeConfig,
    change: &SyncChange,
    root_kind: &str,
    target_path: &Path,
) -> Result<bool> {
    let Some(raid) = &change.raid else {
        return Ok(false);
    };
    let mut shards = std::collections::BTreeMap::<i64, Vec<u8>>::new();
    for shard in &raid.shards {
        let Some(source) = shard.sources.first() else {
            continue;
        };
        let bytes = download_bytes_from_ticket(&source.endpoint_url, &source.ticket)?;
        shards.insert(shard.shard_index, bytes);
        if shards.len() >= DEFAULT_RAID_QUORUM {
            break;
        }
    }
    if shards.len() < DEFAULT_RAID_QUORUM {
        return Ok(false);
    }
    let data0 = if let Some(bytes) = shards.get(&0) {
        bytes.clone()
    } else if let (Some(data1), Some(parity)) = (shards.get(&1), shards.get(&2)) {
        xor_bytes(data1, parity)
    } else {
        return Ok(false);
    };
    let data1 = if let Some(bytes) = shards.get(&1) {
        bytes.clone()
    } else if let (Some(data0_bytes), Some(parity)) = (shards.get(&0), shards.get(&2)) {
        xor_bytes(data0_bytes, parity)
    } else {
        return Ok(false);
    };
    let mut merged = data0;
    merged.extend_from_slice(&data1);
    merged.truncate(raid.size_bytes.max(0) as usize);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }
    upsert_transfer_progress(state, root_kind, &change.path, "download", "reconstructing", "active", raid.size_bytes, 0, None)?;
    fs::write(target_path, &merged).with_context(|| format!("failed to write {}", target_path.display()))?;
    upsert_transfer_progress(state, root_kind, &change.path, "download", "completed", "completed", raid.size_bytes, raid.size_bytes, None)?;
    if let Some(hash) = change.sha256.as_deref() {
        let _ = publish_peer_availability(config, root_kind, &change.path, change.revision, raid.size_bytes, hash);
    }
    Ok(true)
}

fn upsert_transfer_progress(
    state: &AppState,
    root_kind: &str,
    relative_path: &str,
    direction: &str,
    phase: &str,
    status: &str,
    bytes_total: i64,
    bytes_done: i64,
    message: Option<&str>,
) -> Result<()> {
    let conn = state.connect()?;
    conn.execute(
        r#"
        INSERT INTO transfer_progress (root_kind, relative_path, direction, phase, status, bytes_total, bytes_done, message, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)
        ON CONFLICT(root_kind, relative_path, direction) DO UPDATE SET
          phase = excluded.phase,
          status = excluded.status,
          bytes_total = excluded.bytes_total,
          bytes_done = excluded.bytes_done,
          message = excluded.message,
          updated_at = CURRENT_TIMESTAMP
        "#,
        params![root_kind, relative_path, direction, phase, status, bytes_total, bytes_done, message],
    )?;
    Ok(())
}

struct ProgressReader {
    file: fs::File,
    state: AppState,
    root_kind: String,
    relative_path: String,
    direction: String,
    bytes_total: i64,
    bytes_done: i64,
    last_emitted: i64,
}

impl ProgressReader {
    fn new(file: fs::File, state: AppState, root_kind: &str, relative_path: &str, direction: &str, bytes_total: i64) -> Self {
        Self {
            file,
            state,
            root_kind: root_kind.to_string(),
            relative_path: relative_path.to_string(),
            direction: direction.to_string(),
            bytes_total,
            bytes_done: 0,
            last_emitted: 0,
        }
    }

    fn emit_progress(&mut self, phase: &str, status: &str) {
        if self.bytes_done == self.last_emitted && self.bytes_done < self.bytes_total {
            return;
        }
        let _ = upsert_transfer_progress(
            &self.state,
            &self.root_kind,
            &self.relative_path,
            &self.direction,
            phase,
            status,
            self.bytes_total,
            self.bytes_done,
            None,
        );
        self.last_emitted = self.bytes_done;
    }
}

impl Read for ProgressReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.file.read(buf)?;
        if read > 0 {
            self.bytes_done += read as i64;
            if self.bytes_done - self.last_emitted >= 262_144 || self.bytes_done == self.bytes_total {
                self.emit_progress("transferring", "active");
            }
        }
        Ok(read)
    }
}

fn ack_cursor(config: &RuntimeConfig, cursor: i64) -> Result<()> {
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/ack", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "deviceId": config.device_id,
            "cursor": cursor,
            "localRoots": {
                "user_vault": config.user_root.to_string_lossy(),
                "share_vault": config.share_root.to_string_lossy(),
            }
        }))
        .send()
        .context("failed to acknowledge sync cursor")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "ack failed".to_string());
        return Err(anyhow!(body));
    }
    Ok(())
}

fn conflict_copy_path(path: &Path, device_id: &str) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%d%H%M%S").to_string();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault-item".to_string());
    path.with_file_name(format!("{file_name}.conflict-{device_id}-{stamp}"))
}

fn clear_queue_entry(conn: &Connection, root_kind: &str, relative_path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM sync_queue WHERE root_kind = ?1 AND relative_path = ?2",
        params![root_kind, relative_path],
    )?;
    Ok(())
}

fn mark_sync_state(
    conn: &Connection,
    root_kind: &str,
    relative_path: &str,
    hash: Option<&str>,
    revision: i64,
    deleted_at: Option<&str>,
    sync_state: &str,
) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO sync_state (root_kind, relative_path, content_hash, revision, deleted_at, sync_state, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
        ON CONFLICT(root_kind, relative_path) DO UPDATE SET
          content_hash = excluded.content_hash,
          revision = excluded.revision,
          deleted_at = excluded.deleted_at,
          sync_state = excluded.sync_state,
          updated_at = CURRENT_TIMESTAMP
        "#,
        params![root_kind, relative_path, hash, revision, deleted_at, sync_state],
    )?;
    Ok(())
}

fn has_pending_local_change(conn: &Connection, root_kind: &str, relative_path: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE root_kind = ?1 AND relative_path = ?2 AND status IN ('queued', 'failed', 'syncing')",
        params![root_kind, relative_path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn stream_response_to_file(
    state: &AppState,
    root_kind: &str,
    relative_path: &str,
    direction: &str,
    mut response: reqwest::blocking::Response,
    target_path: &Path,
) -> Result<()> {
    let total = response.content_length().unwrap_or(0) as i64;
    upsert_transfer_progress(state, root_kind, relative_path, direction, "transferring", "active", total, 0, None)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(target_path).with_context(|| format!("failed to create {}", target_path.display()))?;
    let mut transferred = 0_i64;
    let mut buffer = vec![0_u8; 262_144];
    loop {
        let read = response.read(&mut buffer).context("failed to read transfer stream")?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).context("failed to write downloaded file")?;
        transferred += read as i64;
        upsert_transfer_progress(state, root_kind, relative_path, direction, "transferring", "active", total, transferred, None)?;
    }
    upsert_transfer_progress(state, root_kind, relative_path, direction, "completed", "completed", total, transferred, None)?;
    Ok(())
}

fn download_from_peer_source(
    state: &AppState,
    config: &RuntimeConfig,
    change: &SyncChange,
    root_kind: &str,
    target_path: &Path,
) -> Result<bool> {
    let client = auth_client()?;
    for source in &change.peer_sources {
        let request_url = reqwest::Url::parse_with_params(
            &format!("{}/peer/file", source.endpoint_url.trim_end_matches('/')),
            &[("ticket", source.ticket.as_str())],
        )
            .with_context(|| format!("invalid peer endpoint {}", source.endpoint_url))?;
        let response = client
            .get(request_url)
            .send()
            .with_context(|| format!("failed to connect to peer {}", source.device_id));
        match response {
            Ok(response) if response.status().is_success() => {
                stream_response_to_file(state, root_kind, &change.path, "download", response, target_path)?;
                if let Some(hash) = change.sha256.as_deref().or(source.sha256.as_deref()) {
                    let _ = publish_peer_availability(config, root_kind, &change.path, change.revision, source.size_bytes.max(0), hash);
                }
                return Ok(true);
            }
            Ok(response) => {
                let body = response.text().unwrap_or_else(|_| "peer download failed".to_string());
                let _ = log_activity(
                    state,
                    "warn",
                    &format!("Peer source {} rejected {}: {}", source.device_id, change.path, body),
                );
            }
            Err(error) => {
                let _ = log_activity(
                    state,
                    "warn",
                    &format!("Peer source {} unavailable for {}: {}", source.device_id, change.path, error),
                );
            }
        }
    }
    Ok(false)
}

fn download_remote_file(
    state: &AppState,
    config: &RuntimeConfig,
    change: &SyncChange,
    root_kind: &str,
    password: Option<&str>,
    target_path: &Path,
) -> Result<()> {
    if config.transport_mode == "peer" && download_from_peer_source(state, config, change, root_kind, target_path)? {
        return Ok(());
    }
    if config.transport_mode == "peer" && reconstruct_file_from_raid(state, config, change, root_kind, target_path)? {
        return Ok(());
    }
    let Some(file_id) = &change.file_id else {
        return Err(anyhow!("sync change missing file id"));
    };
    let client = auth_client()?;
    let url = if change.vault_id == config.share_vault_id {
        format!("{}/api/share/files/{file_id}/download", config.server_url)
    } else {
        format!("{}/api/files/{file_id}/download", config.server_url)
    };
    let mut request = client.get(url).bearer_auth(&config.token);
    if change.vault_id == config.user_vault_id {
        let password = password.ok_or_else(|| anyhow!("private vault password is required to download remote changes"))?;
        request = request.header("x-vault-password", password);
    }
    let response = request.send().context("failed to download remote file")?;
    if !response.status().is_success() {
        let body = response.text().unwrap_or_else(|_| "download failed".to_string());
        return Err(anyhow!(body));
    }
    if config.transport_mode == "peer" {
        return Err(anyhow!("no peer source is currently available for {}", change.path));
    }
    stream_response_to_file(state, root_kind, &change.path, "download", response, target_path)
}

fn apply_remote_change(state: &AppState, config: &RuntimeConfig, change: &SyncChange, password: Option<&str>) -> Result<SyncSummary> {
    let (root_kind, root_path) = if change.vault_id == config.user_vault_id {
        ("user_vault", &config.user_root)
    } else if change.vault_id == config.share_vault_id {
        ("share_vault", &config.share_root)
    } else {
        return Ok(SyncSummary::default());
    };

    let conn = state.connect()?;
    let target_path = join_root_path(root_path, &change.path);
    let mut summary = SyncSummary::default();
    let pending = has_pending_local_change(&conn, root_kind, &change.path)?;
    if pending && target_path.is_file() {
        let conflict_target = conflict_copy_path(&target_path, &config.device_id);
        fs::copy(&target_path, &conflict_target).ok();
        let message = format!("Preserved local edit at {} as {}", change.path, conflict_target.display());
        add_conflict(state, root_kind, &change.path, &message)?;
        log_activity(state, "warn", &message)?;
        clear_queue_entry(&conn, root_kind, &change.path)?;
        summary.conflicts += 1;
    }

    match change.operation.as_str() {
        "folder_create" => {
            suppress_path(state, &target_path);
            fs::create_dir_all(&target_path)?;
            mark_sync_state(&conn, root_kind, &change.path, None, change.revision, None, "synced")?;
            summary.folders_created += 1;
        }
        "file_upsert" => {
            suppress_path(state, &target_path);
            download_remote_file(state, config, change, root_kind, password, &target_path)?;
            clear_queue_entry(&conn, root_kind, &change.path)?;
            mark_sync_state(&conn, root_kind, &change.path, change.sha256.as_deref(), change.revision, None, "synced")?;
            summary.downloads += 1;
        }
        "file_delete" | "folder_delete" => {
            if target_path.is_dir() {
                suppress_path(state, &target_path);
                let _ = fs::remove_dir_all(&target_path);
            } else if target_path.exists() {
                suppress_path(state, &target_path);
                let _ = fs::remove_file(&target_path);
            }
            clear_queue_entry(&conn, root_kind, &change.path)?;
            mark_sync_state(
                &conn,
                root_kind,
                &change.path,
                None,
                change.revision,
                Some(&Utc::now().to_rfc3339()),
                "synced",
            )?;
            summary.deletions += 1;
        }
        _ => {}
    }

    Ok(summary)
}

fn process_remote_changes(state: &AppState, config: &RuntimeConfig, password: Option<&str>) -> Result<SyncSummary> {
    let client = auth_client()?;
    let mut summary = SyncSummary::default();
    let mut cursor = config.last_cursor;

    loop {
        let response = client
            .get(format!("{}/api/sync/changes", config.server_url))
            .bearer_auth(&config.token)
            .query(&[("cursor", cursor.to_string()), ("deviceId", config.device_id.clone())])
            .send()
            .context("failed to request remote changes")?;
        let payload: SyncChangesResponse = decode_json(response)?;
        if payload.transport_mode != config.transport_mode {
            let conn = state.connect()?;
            set_transport_mode_setting(&conn, &payload.transport_mode)?;
        }
        let mut page_summary = SyncSummary::default();
        for change in &payload.changes {
            page_summary = merge_summary(page_summary, apply_remote_change(state, config, change, password)?);
            cursor = cursor.max(change.cursor);
        }
        summary = merge_summary(summary, page_summary);
        if !payload.has_more || payload.changes.is_empty() {
            break;
        }
    }

    if cursor > config.last_cursor {
        ack_cursor(config, cursor)?;
        save_last_cursor(state, cursor)?;
    }
    summary.cursor = cursor;
    Ok(summary)
}

fn merge_summary(mut left: SyncSummary, right: SyncSummary) -> SyncSummary {
    left.uploads += right.uploads;
    left.downloads += right.downloads;
    left.deletions += right.deletions;
    left.folders_created += right.folders_created;
    left.conflicts += right.conflicts;
    left.cursor = left.cursor.max(right.cursor);
    left
}

fn process_queue(state: &AppState, config: &RuntimeConfig, password: Option<&str>) -> Result<SyncSummary> {
    let conn = state.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id, root_kind, relative_path, operation FROM sync_queue WHERE status IN ('queued', 'failed', 'syncing') ORDER BY updated_at ASC, id ASC",
    )?;
    let queue = stmt
        .query_map([], |row| {
            Ok(QueueItem {
                id: row.get(0)?,
                root_kind: row.get(1)?,
                relative_path: row.get(2)?,
                operation: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let client = auth_client()?;
    let mut summary = SyncSummary::default();

    for item in queue {
        conn.execute(
            "UPDATE sync_queue SET status = 'syncing', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [item.id],
        )?;

        let root_path = if item.root_kind == "share_vault" {
            &config.share_root
        } else {
            &config.user_root
        };
        let full_path = join_root_path(root_path, &item.relative_path);

        let result: Result<()> = match item.operation.as_str() {
            "create_folder" => {
                let (parent_path, name) = split_relative_path(&item.relative_path)?;
                let response = client
                    .post(format!("{}/api/sync/folders/create", config.server_url))
                    .bearer_auth(&config.token)
                    .json(&json!({
                        "deviceId": config.device_id,
                        "rootKind": item.root_kind,
                        "parentPath": parent_path,
                        "name": name
                    }))
                    .send()
                    .context("failed to create remote folder")?;
                if !response.status().is_success() {
                    let body = response.text().unwrap_or_else(|_| "remote folder create failed".to_string());
                    Err(anyhow!(body))
                } else {
                    mark_sync_state(&conn, &item.root_kind, &item.relative_path, None, 0, None, "synced")?;
                    summary.folders_created += 1;
                    Ok(())
                }
            }
            "delete_path" => {
                let response = client
                    .post(format!("{}/api/sync/files/delete", config.server_url))
                    .bearer_auth(&config.token)
                    .json(&json!({
                        "deviceId": config.device_id,
                        "rootKind": item.root_kind,
                        "relativePath": item.relative_path
                    }))
                    .send()
                    .context("failed to delete remote path")?;
                if !response.status().is_success() {
                    let body = response.text().unwrap_or_else(|_| "remote delete failed".to_string());
                    Err(anyhow!(body))
                } else {
                    let _ = unpublish_peer_availability(config, &item.root_kind, &item.relative_path);
                    mark_sync_state(
                        &conn,
                        &item.root_kind,
                        &item.relative_path,
                        None,
                        0,
                        Some(&Utc::now().to_rfc3339()),
                        "synced",
                    )?;
                    summary.deletions += 1;
                    Ok(())
                }
            }
            _ => {
                if !full_path.exists() || full_path.is_dir() {
                    let response = client
                        .post(format!("{}/api/sync/files/delete", config.server_url))
                        .bearer_auth(&config.token)
                        .json(&json!({
                            "deviceId": config.device_id,
                            "rootKind": item.root_kind,
                            "relativePath": item.relative_path
                        }))
                        .send()
                        .context("failed to delete remote file after local removal")?;
                    if !response.status().is_success() {
                        let body = response.text().unwrap_or_else(|_| "remote delete failed".to_string());
                        Err(anyhow!(body))
                    } else {
                        let _ = unpublish_peer_availability(config, &item.root_kind, &item.relative_path);
                        mark_sync_state(
                            &conn,
                            &item.root_kind,
                            &item.relative_path,
                            None,
                            0,
                            Some(&Utc::now().to_rfc3339()),
                            "synced",
                        )?;
                        summary.deletions += 1;
                        Ok(())
                    }
                } else {
                    let (sha256, total) = hash_file(&full_path)?;
                    upsert_transfer_progress(state, &item.root_kind, &item.relative_path, "upload", "preparing", "active", total, 0, None)?;
                    if config.transport_mode == "peer" {
                        let response = client
                            .post(format!("{}/api/sync/files/register", config.server_url))
                            .bearer_auth(&config.token)
                            .json(&json!({
                                "deviceId": config.device_id,
                                "rootKind": item.root_kind,
                                "relativePath": item.relative_path,
                                "mimeType": guess_mime_type(&full_path),
                                "sizeBytes": total,
                                "sha256": sha256,
                            }))
                            .send()
                            .context("failed to register desktop peer file")?;
                        if !response.status().is_success() {
                            let body = response.text().unwrap_or_else(|_| "peer register failed".to_string());
                            Err(anyhow!(body))
                        } else {
                            let payload: SyncFileRegisterResponse = decode_json(response)?;
                            if config.raid_enabled && item.root_kind == "user_vault" {
                                let file_bytes = fs::read(&full_path).with_context(|| format!("failed to read {}", full_path.display()))?;
                                let (shard_bytes, _shard_payloads, shards) = build_raid_shard_bytes(&file_bytes);
                                let raid_response = client
                                    .post(format!("{}/api/sync/raid/register", config.server_url))
                                    .bearer_auth(&config.token)
                                    .json(&json!({
                                        "deviceId": config.device_id,
                                        "rootKind": item.root_kind,
                                        "relativePath": item.relative_path,
                                        "revision": payload.item.revision,
                                        "sizeBytes": total,
                                        "sha256": sha256,
                                        "shardBytes": shard_bytes,
                                        "shards": shards,
                                    }))
                                    .send()
                                    .context("failed to register RAID manifest")?;
                                if !raid_response.status().is_success() {
                                    let body = raid_response.text().unwrap_or_else(|_| "raid register failed".to_string());
                                    return Err(anyhow!(body));
                                }
                                let _payload: RaidRegisterResponse = decode_json(raid_response)?;
                            }
                            publish_peer_availability(
                                config,
                                &item.root_kind,
                                &item.relative_path,
                                payload.item.revision,
                                total,
                                &sha256,
                            )?;
                            upsert_transfer_progress(state, &item.root_kind, &item.relative_path, "upload", "completed", "completed", total, total, None)?;
                            mark_sync_state(&conn, &item.root_kind, &item.relative_path, Some(&sha256), payload.item.revision, None, "synced")?;
                            summary.uploads += 1;
                            Ok(())
                        }
                    } else {
                        let (parent_path, file_name) = split_relative_path(&item.relative_path)?;
                        let file = fs::File::open(&full_path).with_context(|| format!("failed to open {}", full_path.display()))?;
                        let body = reqwest::blocking::Body::new(ProgressReader::new(
                            file,
                            state.clone(),
                            &item.root_kind,
                            &item.relative_path,
                            "upload",
                            total,
                        ));
                        let mut request = client
                            .post(format!("{}/api/sync/files/upload", config.server_url))
                            .bearer_auth(&config.token)
                            .header("x-device-id", &config.device_id)
                            .header("x-root-kind", &item.root_kind)
                            .header("x-relative-path", parent_path)
                            .header("x-file-name", file_name)
                            .header("content-type", "application/octet-stream");
                        if item.root_kind == "user_vault" {
                            let private_password =
                                password.ok_or_else(|| anyhow!("private vault password is required for upload"))?;
                            request = request.header("x-vault-password", private_password);
                        }
                        upsert_transfer_progress(state, &item.root_kind, &item.relative_path, "upload", "transferring", "active", total, 0, None)?;
                        let response = request.body(body).send().context("failed to upload file")?;
                        if !response.status().is_success() {
                            let body = response.text().unwrap_or_else(|_| "upload failed".to_string());
                            Err(anyhow!(body))
                        } else {
                            upsert_transfer_progress(state, &item.root_kind, &item.relative_path, "upload", "completed", "completed", total, total, None)?;
                            mark_sync_state(&conn, &item.root_kind, &item.relative_path, Some(&sha256), 0, None, "synced")?;
                            summary.uploads += 1;
                            Ok(())
                        }
                    }
                }
            }
        };

        match result {
            Ok(()) => {
                conn.execute("DELETE FROM sync_queue WHERE id = ?1", [item.id])?;
            }
            Err(error) => {
                let _ = upsert_transfer_progress(
                    state,
                    &item.root_kind,
                    &item.relative_path,
                    if item.operation == "create_folder" || item.operation == "delete_path" { "sync" } else { "upload" },
                    "failed",
                    "failed",
                    0,
                    0,
                    Some(&error.to_string()),
                );
                conn.execute(
                    "UPDATE sync_queue SET status = 'failed', attempts = attempts + 1, error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    params![item.id, error.to_string()],
                )?;
                log_activity(state, "error", &format!("Sync failed for {} {}: {}", item.operation, item.relative_path, error))?;
            }
        }
    }

    Ok(summary)
}

pub(crate) fn perform_sync_cycle(state: &AppState) -> Result<SyncSummary> {
    let Some(config) = load_runtime_config(state)? else {
        return Ok(SyncSummary::default());
    };
    if !config.sync_enabled {
        return Ok(SyncSummary::default());
    }
    if config.transport_mode == "peer" {
        let _ = register_peer_endpoint(state, &config);
    }
    let password = load_private_password(state, &config)?;
    let upload_summary = process_queue(state, &config, password.as_deref())?;
    if config.transport_mode == "peer" && config.raid_enabled {
        let _ = process_raid_assignments(state, &config);
    }
    let remote_summary = if config.sync_mode == "push_only" {
        SyncSummary::default()
    } else {
        process_remote_changes(state, &config, password.as_deref())?
    };
    let summary = merge_summary(upload_summary, remote_summary);
    if summary.uploads + summary.downloads + summary.deletions + summary.folders_created + summary.conflicts > 0 {
        log_activity(
            state,
            "info",
            &format!(
                "Sync cycle finished: {} uploads, {} downloads, {} deletes, {} folders, {} conflicts",
                summary.uploads, summary.downloads, summary.deletions, summary.folders_created, summary.conflicts
            ),
        )?;
    }
    Ok(summary)
}

fn ensure_local_roots(base_dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let user_root = base_dir.join("User Vault");
    let share_root = base_dir.join("Share Folder");
    let reserve_root = base_dir.join("Raid Reserve");
    fs::create_dir_all(&user_root)?;
    fs::create_dir_all(&share_root)?;
    fs::create_dir_all(&reserve_root)?;
    Ok((user_root, share_root, reserve_root))
}

fn get_or_create_device_id(conn: &Connection) -> Result<String> {
    if let Some(existing) = get_setting(conn, "device_id")? {
        return Ok(existing);
    }
    let generated = format!("desktop-{}", Uuid::new_v4());
    set_setting(conn, "device_id", &generated)?;
    Ok(generated)
}

fn check_for_update_inner() -> Result<UpdateCheckResult> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = auth_client()?;
    let response = client
        .get("https://api.github.com/repos/pranto48/torrent-shred-vault/releases/latest")
        .header("User-Agent", "torrent-shred-vault-desktop")
        .send()
        .context("failed to query GitHub releases")?;
    let release: GitHubRelease = decode_json(response)?;
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let current = Version::parse(&current_version).unwrap_or_else(|_| Version::new(0, 0, 0));
    let latest = Version::parse(&latest_version).unwrap_or_else(|_| current.clone());
    let preferred_asset = release
        .assets
        .iter()
        .find(|asset| asset.name.ends_with(".msi"))
        .or_else(|| release.assets.iter().find(|asset| asset.name.ends_with(".exe")))
        .or_else(|| release.assets.first());

    Ok(UpdateCheckResult {
        current_version,
        latest_version: Some(latest_version.clone()),
        has_update: latest > current || latest_version != env!("CARGO_PKG_VERSION"),
        html_url: Some(release.html_url),
        asset_url: preferred_asset.map(|asset| asset.browser_download_url.clone()),
        asset_name: preferred_asset.map(|asset| asset.name.clone()),
        notes: release.body,
    })
}

fn open_external_url(url: &str) -> Result<()> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .context("failed to open external URL")?;
    Ok(())
}

fn peer_root_for_kind<'a>(config: &'a RuntimeConfig, root_kind: &str) -> Option<&'a Path> {
    match root_kind {
        "share_vault" => Some(config.share_root.as_path()),
        "user_vault" => Some(config.user_root.as_path()),
        _ => None,
    }
}

fn write_http_response(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: Option<&[u8]>) -> Result<()> {
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes())?;
    if let Some(body) = body {
        stream.write_all(body)?;
    }
    Ok(())
}

fn handle_peer_client(state: AppState, mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut buffer = [0_u8; 8192];
    let read = stream.read(&mut buffer).context("failed to read peer request")?;
    if read == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut lines = request.lines();
    let Some(first_line) = lines.next() else {
        return Ok(());
    };
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");
    if method != "GET" {
        let _ = write_http_response(
            &mut stream,
            "405 Method Not Allowed",
            &[("Content-Length", "0".to_string())],
            None,
        );
        return Ok(());
    }

    if target == "/health" {
        let body = b"ok";
        let _ = write_http_response(
            &mut stream,
            "200 OK",
            &[("Content-Type", "text/plain".to_string()), ("Content-Length", body.len().to_string())],
            Some(body),
        );
        return Ok(());
    }

    let request_url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).context("invalid peer request URL")?;
    if request_url.path() != "/peer/file" && request_url.path() != "/peer/raid-shard" {
        let _ = write_http_response(
            &mut stream,
            "404 Not Found",
            &[("Content-Length", "0".to_string())],
            None,
        );
        return Ok(());
    }

    let ticket = request_url
        .query_pairs()
        .find_map(|(key, value)| (key == "ticket").then_some(value.to_string()))
        .ok_or_else(|| anyhow!("missing peer ticket"))?;
    let Some(config) = load_runtime_config(&state)? else {
        let _ = write_http_response(
            &mut stream,
            "503 Service Unavailable",
            &[("Content-Length", "0".to_string())],
            None,
        );
        return Ok(());
    };
    let client = auth_client()?;
    let response = client
        .post(format!("{}/api/sync/peer/tickets/validate", config.server_url))
        .bearer_auth(&config.token)
        .json(&json!({
            "ticket": ticket,
            "deviceId": config.device_id,
        }))
        .send()
        .context("failed to validate peer ticket")?;
    let validated: PeerValidateResponse = decode_json(response)?;
    if validated.ticket.source_device_id != config.device_id {
        let _ = write_http_response(
            &mut stream,
            "403 Forbidden",
            &[("Content-Length", "0".to_string())],
            None,
        );
        return Ok(());
    }

    let payload = if request_url.path() == "/peer/file" {
        let relative_path = &validated.ticket.path;
        let root_kind = validated.ticket.root_kind.as_str();
        let root = if let Some(root) = peer_root_for_kind(&config, root_kind) {
            root
        } else {
            let _ = write_http_response(&mut stream, "404 Not Found", &[("Content-Length", "0".to_string())], None);
            return Ok(());
        };
        let file_path = join_root_path(root, relative_path);
        if !file_path.is_file() {
            let _ = write_http_response(&mut stream, "404 Not Found", &[("Content-Length", "0".to_string())], None);
            return Ok(());
        }
        fs::read(&file_path).with_context(|| format!("failed to read {}", file_path.display()))?
    } else {
        match validated.ticket.kind.as_str() {
            "raid_source_file" => {
                let root = if let Some(root) = peer_root_for_kind(&config, &validated.ticket.root_kind) {
                    root
                } else {
                    let _ = write_http_response(&mut stream, "404 Not Found", &[("Content-Length", "0".to_string())], None);
                    return Ok(());
                };
                let file_path = join_root_path(root, &validated.ticket.path);
                if !file_path.is_file() {
                    let _ = write_http_response(&mut stream, "404 Not Found", &[("Content-Length", "0".to_string())], None);
                    return Ok(());
                }
                let file_bytes = fs::read(&file_path).with_context(|| format!("failed to read {}", file_path.display()))?;
                let (_, shard_payloads, _) = build_raid_shard_bytes(&file_bytes);
                let shard_index = validated.ticket.shard_index.unwrap_or(0).max(0) as usize;
                shard_payloads.get(shard_index).cloned().ok_or_else(|| anyhow!("RAID shard index out of range"))?
            }
            "raid_hosted_shard" => {
                let shard_id = validated.ticket.shard_id.clone().ok_or_else(|| anyhow!("missing RAID shard id"))?;
                let conn = state.connect()?;
                let local_path: String = conn
                    .query_row(
                        "SELECT local_path FROM raid_local_shards WHERE shard_id = ?1 AND status = 'available'",
                        [shard_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| anyhow!("RAID shard not available on this device"))?;
                fs::read(&local_path).with_context(|| format!("failed to read {}", local_path))?
            }
            _ => {
                let _ = write_http_response(&mut stream, "404 Not Found", &[("Content-Length", "0".to_string())], None);
                return Ok(());
            }
        }
    };

    let size = payload.len();
    write_http_response(
        &mut stream,
        "200 OK",
        &[
            ("Content-Type", "application/octet-stream".to_string()),
            ("Content-Length", size.to_string()),
            ("Connection", "close".to_string()),
        ],
        None,
    )?;
    stream.write_all(&payload).context("failed to stream peer payload")?;
    Ok(())
}

pub(crate) fn run_peer_listener(state: AppState) {
    let mut listener: Option<TcpListener> = None;
    let mut bound_port: Option<u16> = None;

    loop {
        let port = state
            .connect()
            .ok()
            .and_then(|conn| get_peer_port(&conn).ok())
            .unwrap_or(DEFAULT_PEER_PORT);

        if listener.is_none() || bound_port != Some(port) {
            listener = TcpListener::bind(("0.0.0.0", port)).ok();
            bound_port = listener.as_ref().map(|_| port);
            if let Some(active) = &listener {
                let _ = active.set_nonblocking(true);
                let _ = log_activity(&state, "info", &format!("Desktop peer listener ready on port {}", port));
            }
        }

        if let Some(active) = &listener {
            match active.accept() {
                Ok((stream, _)) => {
                    let child_state = state.clone();
                    thread::spawn(move || {
                        if let Err(error) = handle_peer_client(child_state.clone(), stream) {
                            let _ = log_activity(&child_state, "warn", &format!("Peer transfer request failed: {}", error));
                        }
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(PEER_LISTENER_POLL_MS));
                }
                Err(error) => {
                    let _ = log_activity(&state, "error", &format!("Peer listener failed: {}", error));
                    listener = None;
                    thread::sleep(Duration::from_secs(2));
                }
            }
        } else {
            thread::sleep(Duration::from_secs(2));
        }
    }
}

#[tauri::command]
fn get_app_status(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_server_url(state: State<'_, AppState>, server_url: String) -> Result<DesktopStatus, String> {
    let conn = state.connect().map_err(|error| error.to_string())?;
    set_setting(&conn, "server_url", &normalize_server_url(&server_url)).map_err(|error| error.to_string())?;
    log_activity(&state, "info", "Desktop server URL updated").map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_sync_mode(state: State<'_, AppState>, sync_mode: String) -> Result<DesktopStatus, String> {
    let conn = state.connect().map_err(|error| error.to_string())?;
    set_sync_mode_setting(&conn, &sync_mode).map_err(|error| error.to_string())?;
    log_activity(&state, "info", &format!("Desktop sync mode set to {}", if sync_mode == "push_only" { "push only" } else { "two way" }))
        .map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_startup_enabled(state: State<'_, AppState>, enabled: bool) -> Result<DesktopStatus, String> {
    set_startup_enabled_internal(enabled).map_err(|error| error.to_string())?;
    log_activity(
        &state,
        "info",
        if enabled {
            "Windows startup enabled"
        } else {
            "Windows startup disabled"
        },
    )
    .map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn desktop_login(
    state: State<'_, AppState>,
    server_url: String,
    email: String,
    password: String,
    remember_password_flag: bool,
    base_dir: Option<String>,
) -> Result<LoginResult, String> {
    let server_url = normalize_server_url(&server_url);
    let client = auth_client().map_err(|error| error.to_string())?;
    let login_response = client
        .post(format!("{server_url}/api/auth/login"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .context("failed to log in")
        .and_then(decode_json::<LoginResponse>)
        .map_err(|error| error.to_string())?;

    let conn = state.connect().map_err(|error| error.to_string())?;
    let device_id = get_or_create_device_id(&conn).map_err(|error| error.to_string())?;
    let base_dir_path = base_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| default_base_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let (user_root, share_root, reserve_root) = ensure_local_roots(&base_dir_path).map_err(|error| error.to_string())?;

    let bootstrap_response = client
        .get(format!("{server_url}/api/sync/bootstrap"))
        .bearer_auth(&login_response.token)
        .query(&[
            ("deviceId", device_id.clone()),
            ("deviceName", hostname()),
            ("platform", "windows".to_string()),
        ])
        .send()
        .context("failed to bootstrap desktop sync")
        .and_then(decode_json::<BootstrapResponse>)
        .map_err(|error| error.to_string())?;

    let user_vault = bootstrap_response
        .vaults
        .iter()
        .find(|vault| vault.r#type == "user_vault")
        .ok_or_else(|| "user_vault not found".to_string())?;
    let share_vault = bootstrap_response
        .vaults
        .iter()
        .find(|vault| vault.r#type == "share_vault")
        .ok_or_else(|| "share_vault not found".to_string())?;

    set_setting(&conn, "server_url", &server_url).map_err(|error| error.to_string())?;
    set_setting(&conn, "auth_token", &login_response.token).map_err(|error| error.to_string())?;
    set_setting(&conn, "user_email", &login_response.user.email).map_err(|error| error.to_string())?;
    set_setting(&conn, "user_id", &login_response.user.id).map_err(|error| error.to_string())?;
    set_setting(&conn, "user_role", &login_response.user.role).map_err(|error| error.to_string())?;
    set_setting(&conn, "device_id", &bootstrap_response.device.device_id).map_err(|error| error.to_string())?;
    set_setting(&conn, "user_vault_id", &user_vault.id).map_err(|error| error.to_string())?;
    set_setting(&conn, "share_vault_id", &share_vault.id).map_err(|error| error.to_string())?;
    set_setting(&conn, "base_dir", &base_dir_path.to_string_lossy()).map_err(|error| error.to_string())?;
    set_setting(&conn, "user_root", &user_root.to_string_lossy()).map_err(|error| error.to_string())?;
    set_setting(&conn, "share_root", &share_root.to_string_lossy()).map_err(|error| error.to_string())?;
    set_setting(&conn, "reserve_root", &reserve_root.to_string_lossy()).map_err(|error| error.to_string())?;
    set_transport_mode_setting(&conn, &bootstrap_response.transport_mode).map_err(|error| error.to_string())?;
    set_setting(&conn, "peer_port", &bootstrap_response.peer.default_port.to_string()).map_err(|error| error.to_string())?;
    set_bool_setting(&conn, "raid_enabled", bootstrap_response.raid.enabled).map_err(|error| error.to_string())?;
    set_setting(&conn, "raid_data_shards", &bootstrap_response.raid.data_shards.to_string()).map_err(|error| error.to_string())?;
    set_setting(&conn, "raid_parity_shards", &bootstrap_response.raid.parity_shards.to_string()).map_err(|error| error.to_string())?;
    set_setting(&conn, "raid_quorum_shards", &bootstrap_response.raid.quorum_shards.to_string()).map_err(|error| error.to_string())?;
    set_setting(&conn, "raid_reserve_bytes", &bootstrap_response.raid.reserve_bytes.to_string()).map_err(|error| error.to_string())?;
    set_setting(
        &conn,
        "last_cursor",
        &bootstrap_response.device.last_cursor.min(bootstrap_response.cursor).to_string(),
    )
    .map_err(|error| error.to_string())?;
    set_bool_setting(&conn, "remember_password", remember_password_flag).map_err(|error| error.to_string())?;
    set_bool_setting(&conn, "sync_enabled", true).map_err(|error| error.to_string())?;
    set_sync_mode_setting(&conn, &get_sync_mode(&conn).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;

    remember_password(&state, &login_response.user.email, &password, remember_password_flag)
        .map_err(|error| error.to_string())?;
    log_activity(&state, "info", &format!("Signed in to {server_url} as {}", login_response.user.email))
        .map_err(|error| error.to_string())?;
    if let Some(config) = load_runtime_config(&state).map_err(|error| error.to_string())? {
        let _ = register_peer_endpoint(&state, &config);
        let _ = publish_local_catalog(&state, &config);
    }

    let summary = perform_sync_cycle(&state).map_err(|error| error.to_string())?;
    let status = current_status(&state).map_err(|error| error.to_string())?;
    Ok(LoginResult { status, summary })
}

#[tauri::command]
fn unlock_private_vault(
    state: State<'_, AppState>,
    password: String,
    remember_password_flag: bool,
) -> Result<DesktopStatus, String> {
    let Some(config) = load_runtime_config(&state).map_err(|error| error.to_string())? else {
        return Err("Desktop client is not configured".to_string());
    };
    remember_password(&state, &config.user_email, &password, remember_password_flag)
        .map_err(|error| error.to_string())?;
    let conn = state.connect().map_err(|error| error.to_string())?;
    set_bool_setting(&conn, "remember_password", remember_password_flag).map_err(|error| error.to_string())?;
    log_activity(&state, "info", "Private vault unlocked").map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_sync(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    set_sync_enabled(&state, true).map_err(|error| error.to_string())?;
    log_activity(&state, "info", "Background sync enabled").map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn pause_sync(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    set_sync_enabled(&state, false).map_err(|error| error.to_string())?;
    log_activity(&state, "info", "Background sync paused").map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Result<SyncSummary, String> {
    perform_sync_cycle(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn check_desktop_update() -> Result<UpdateCheckResult, String> {
    check_for_update_inner().map_err(|error| error.to_string())
}

#[tauri::command]
fn download_desktop_update() -> Result<UpdateCheckResult, String> {
    let update = check_for_update_inner().map_err(|error| error.to_string())?;
    let target = update
        .asset_url
        .clone()
        .or_else(|| update.html_url.clone())
        .ok_or_else(|| "No update download URL is available".to_string())?;
    open_external_url(&target).map_err(|error| error.to_string())?;
    Ok(update)
}

#[tauri::command]
fn quit_desktop_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn clear_session(state: State<'_, AppState>) -> Result<DesktopStatus, String> {
    let conn = state.connect().map_err(|error| error.to_string())?;
    for key in [
        "server_url",
        "auth_token",
        "user_email",
        "user_id",
        "user_role",
        "user_vault_id",
        "share_vault_id",
        "base_dir",
        "user_root",
        "share_root",
        "reserve_root",
        "transport_mode",
        "peer_endpoint",
        "peer_port",
        "raid_enabled",
        "raid_data_shards",
        "raid_parity_shards",
        "raid_quorum_shards",
        "raid_reserve_bytes",
        "last_cursor",
    ] {
        delete_setting(&conn, key).map_err(|error| error.to_string())?;
    }
    if let Ok(mut in_memory) = state.memory_password.lock() {
        *in_memory = None;
    }
    log_activity(&state, "info", "Desktop session cleared").map_err(|error| error.to_string())?;
    current_status(&state).map_err(|error| error.to_string())
}

pub(crate) fn root_kind_for_path(config: &RuntimeConfig, path: &Path) -> Option<(&'static str, PathBuf, PathBuf)> {
    if path.starts_with(&config.user_root) {
        return Some((
            "user_vault",
            config.user_root.clone(),
            path.strip_prefix(&config.user_root).ok()?.to_path_buf(),
        ));
    }
    if path.starts_with(&config.share_root) {
        return Some((
            "share_vault",
            config.share_root.clone(),
            path.strip_prefix(&config.share_root).ok()?.to_path_buf(),
        ));
    }
    None
}

pub(crate) fn queue_path_event(state: &AppState, path: &Path) -> Result<()> {
    let Some(config) = runtime_config_for_watch(state) else {
        return Ok(());
    };
    let Some((root_kind, _root_path, relative)) = root_kind_for_path(&config, path) else {
        return Ok(());
    };
    let relative_path = normalize_relative_path(&relative)?;
    if relative_path == "/" {
        return Ok(());
    }
    let operation = if path.exists() {
        if path.is_dir() {
            "create_folder"
        } else {
            "upsert_file"
        }
    } else {
        "delete_path"
    };
    queue_local_event(state, root_kind, &relative_path, operation)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new().expect("failed to initialize desktop state");
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            set_server_url,
            set_sync_mode,
            set_startup_enabled,
            desktop_login,
            unlock_private_vault,
            start_sync,
            pause_sync,
            sync_now,
            check_desktop_update,
            download_desktop_update,
            quit_desktop_app,
            clear_session
        ])
        .setup(|app| {
            let state = app.state::<AppState>();
            watcher::start_background_services(state.inner().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            db_path: self.db_path.clone(),
            memory_password: Arc::clone(&self.memory_password),
            suppressed_paths: Arc::clone(&self.suppressed_paths),
        }
    }
}
