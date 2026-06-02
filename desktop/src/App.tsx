import { FormEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type ActivityRecord = {
  id: number;
  level: string;
  message: string;
  created_at: string;
};

type ConflictRecord = {
  id: number;
  root_kind: string;
  relative_path: string;
  message: string;
  created_at: string;
};

type DesktopStatus = {
  configured: boolean;
  authenticated: boolean;
  sync_enabled: boolean;
  startup_enabled: boolean;
  sync_mode: string;
  transport_mode: string;
  peer_endpoint: string | null;
  peer_port: number;
  peer_ip_override: string | null;
  bandwidth_limit_kbps: number;
  server_url: string | null;
  user_email: string | null;
  device_id: string | null;
  base_dir: string | null;
  user_root: string | null;
  share_root: string | null;
  reserve_root: string | null;
  remember_password: boolean;
  queue_count: number;
  raid_hosted_shards: number;
  raid_pending_jobs: number;
  raid_protected_manifests: number;
  raid_degraded_manifests: number;
  recent_activity: ActivityRecord[];
  conflicts: ConflictRecord[];
  transfers: TransferProgressRecord[];
};

type TransferProgressRecord = {
  id: number;
  root_kind: string;
  relative_path: string;
  direction: string;
  phase: string;
  status: string;
  bytes_total: number;
  bytes_done: number;
  percent: number;
  message: string | null;
  updated_at: string;
};

type SyncSummary = {
  uploads: number;
  downloads: number;
  deletions: number;
  folders_created: number;
  conflicts: number;
  cursor: number;
};

type LoginResult = {
  status: DesktopStatus;
  summary: SyncSummary;
};

type UpdateCheckResult = {
  current_version: string;
  latest_version: string | null;
  has_update: boolean;
  html_url: string | null;
  asset_url: string | null;
  asset_name: string | null;
  notes: string | null;
};

type PeerDevice = {
  deviceId: string;
  deviceName: string;
  platform: string;
  peerEndpointUrl: string | null;
  peerPort: number | null;
  peerTransport: string;
  reserveCapacityBytes: number;
  reserveEnabled: boolean;
  lastSeen: string;
  isOnline: boolean;
};

const defaultServer = "http://192.168.20.5:4400";

function App() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [serverUrl, setServerUrl] = useState(defaultServer);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [baseDir, setBaseDir] = useState("");
  const [bandwidthLimit, setBandwidthLimit] = useState("0");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [peerIpOverride, setPeerIpOverride] = useState("");
  const [peerPort, setPeerPort] = useState("44888");
  const [peerDevices, setPeerDevices] = useState<PeerDevice[]>([]);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!status?.authenticated) return;
    void refreshPeerDevices();
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshPeerDevices();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [status?.authenticated]);

  const needsUnlock = useMemo(() => {
    if (!message) return false;
    return message.toLowerCase().includes("password");
  }, [message]);

  async function refreshStatus() {
    try {
      const nextStatus = await invoke<DesktopStatus>("get_app_status");
      setStatus(nextStatus);
      if (nextStatus.server_url) setServerUrl(nextStatus.server_url);
      if (nextStatus.user_email) setEmail(nextStatus.user_email);
      if (nextStatus.base_dir) setBaseDir(nextStatus.base_dir);
      setRememberPassword(nextStatus.remember_password);
      setBandwidthLimit(String(nextStatus.bandwidth_limit_kbps ?? 0));
      setPeerIpOverride(nextStatus.peer_ip_override ?? "");
      setPeerPort(String(nextStatus.peer_port ?? 44888));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function refreshPeerDevices() {
    try {
      const peers = await invoke<PeerDevice[]>("get_peer_devices");
      setPeerDevices(peers);
    } catch (error) {
      console.error("Failed to load peer devices", error);
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await invoke<LoginResult>("desktop_login", {
        serverUrl,
        email,
        password,
        rememberPasswordFlag: rememberPassword,
        baseDir: baseDir.trim() || null,
      });
      setStatus(result.status);
      setSummary(result.summary);
      setPassword("");
      setUnlockPassword("");
      setMessage(`Signed in. Initial sync cursor: ${result.summary.cursor}`);
      await handleUpdateCheck(false);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveServerUrl() {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("set_server_url", { serverUrl });
      setStatus(nextStatus);
      setMessage("Desktop server URL updated.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetSyncMode(syncMode: "two_way" | "push_only") {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("set_sync_mode", { syncMode });
      setStatus(nextStatus);
      setMessage(syncMode === "push_only" ? "Desktop sync mode set to push only." : "Desktop sync mode set to two-way.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetStartup(enabled: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("set_startup_enabled", { enabled });
      setStatus(nextStatus);
      setMessage(enabled ? "Windows startup enabled." : "Windows startup disabled.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveBandwidthLimit() {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("set_bandwidth_limit", {
        bandwidthLimitKbps: Math.max(0, Number.parseInt(bandwidthLimit || "0", 10) || 0),
      });
      setStatus(nextStatus);
      setMessage(nextStatus.bandwidth_limit_kbps > 0 ? `Bandwidth limit set to ${nextStatus.bandwidth_limit_kbps} KB/s.` : "Bandwidth limit disabled.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("unlock_private_vault", {
        password: unlockPassword,
        rememberPasswordFlag: rememberPassword,
      });
      setStatus(nextStatus);
      setUnlockPassword("");
      setMessage("Private vault unlocked.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    setBusy(true);
    setMessage("");
    try {
      const nextSummary = await invoke<SyncSummary>("sync_now");
      setSummary(nextSummary);
      await refreshStatus();
      setMessage("Sync cycle finished.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleSync(enable: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>(enable ? "start_sync" : "pause_sync");
      setStatus(nextStatus);
      setMessage(enable ? "Background sync enabled." : "Background sync paused.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearSession() {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("clear_session");
      setStatus(nextStatus);
      setSummary(null);
      setUpdateInfo(null);
      setPassword("");
      setUnlockPassword("");
      setEmail("");
      setMessage("Desktop session cleared.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenLogs() {
    setBusy(true);
    setMessage("");
    try {
      await invoke("open_log_folder");
      setMessage("Opened desktop log folder.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePeerSettings() {
    setBusy(true);
    setMessage("");
    try {
      let nextStatus = await invoke<DesktopStatus>("set_peer_ip_override", { ipOverride: peerIpOverride });
      const portNum = Math.max(1024, Math.min(65535, Number.parseInt(peerPort, 10) || 44888));
      nextStatus = await invoke<DesktopStatus>("set_peer_port", { peerPort: portNum });
      setStatus(nextStatus);
      setPeerIpOverride(nextStatus.peer_ip_override ?? "");
      setPeerPort(String(nextStatus.peer_port));
      setMessage("Peer connection settings updated and re-registered.");
      void refreshPeerDevices();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRaidRepair() {
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("trigger_raid_repair");
      setStatus(nextStatus);
      setMessage("RAID repair and rebalance job triggered on the swarm.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetLocalSyncState() {
    if (!window.confirm("Reset local sync queue, transfer state, and conflict records? Local files are not deleted.")) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const nextStatus = await invoke<DesktopStatus>("reset_local_sync_state");
      setStatus(nextStatus);
      setSummary(null);
      setMessage("Local sync state reset. Local files were not deleted.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateCheck(showMessage = true) {
    setBusy(true);
    try {
      const nextUpdate = await invoke<UpdateCheckResult>("check_desktop_update");
      setUpdateInfo(nextUpdate);
      if (showMessage) {
        setMessage(nextUpdate.has_update ? "A desktop update is available." : "Desktop client is up to date.");
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateDownload() {
    setBusy(true);
    try {
      const nextUpdate = await invoke<UpdateCheckResult>("download_desktop_update");
      setUpdateInfo(nextUpdate);
      setMessage("Opened the update download page.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleQuitApp() {
    await invoke("quit_desktop_app");
  }

  return (
    <main className="app-shell">
      <section className="sidebar">
        <div className="brand">
          <span className="brand-kicker">Torrent Shred Vault</span>
          <h1>Desktop Client</h1>
          <p>Windows vault sync, queue control, and software updates.</p>
        </div>

        {!status?.authenticated ? (
          <form className="panel form-panel" onSubmit={handleLogin}>
            <div className="panel-header">
              <h2>First Run Setup</h2>
              <p>Connect this desktop to the Docker web app.</p>
            </div>

            <label>
              <span>Server URL</span>
              <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder={defaultServer} />
            </label>

            <label>
              <span>Admin or User Email</span>
              <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="mail@arifmahmud.com" />
            </label>

            <label>
              <span>Vault Password</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>

            <label>
              <span>Desktop Folder Base</span>
              <input value={baseDir} onChange={(event) => setBaseDir(event.target.value)} placeholder="Documents\\Torrent Shred Vault" />
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={(event) => setRememberPassword(event.target.checked)}
              />
              <span>Store private vault password in Windows Credential Manager</span>
            </label>

            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Signing In..." : "Sign In and Bootstrap"}
            </button>
          </form>
        ) : (
          <section className="panel">
            <div className="panel-header">
              <h2>Session</h2>
              <p>{status.user_email}</p>
            </div>

            <div className="stat-grid compact">
              <div className="stat-card">
                <span className="stat-label">Queue</span>
                <strong>{status.queue_count}</strong>
              </div>
              <div className="stat-card">
                <span className="stat-label">Mode</span>
                <strong>{status.sync_enabled ? "Running" : "Paused"}</strong>
              </div>
            </div>

            <div className="stack">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={status.startup_enabled}
                  onChange={(event) => void handleSetStartup(event.target.checked)}
                />
                <span>Run on Windows startup</span>
              </label>
              <label>
                <span>Server URL</span>
                <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
              </label>
              <button type="button" onClick={() => void handleSaveServerUrl()} disabled={busy}>
                Save Server URL
              </button>
              <div className="button-row">
                <button
                  type="button"
                  className={status.sync_mode === "two_way" ? "primary" : ""}
                  onClick={() => void handleSetSyncMode("two_way")}
                  disabled={busy}
                >
                  Two-Way Sync
                </button>
                <button
                  type="button"
                  className={status.sync_mode === "push_only" ? "primary" : ""}
                  onClick={() => void handleSetSyncMode("push_only")}
                  disabled={busy}
                >
                  Push Only
                </button>
              </div>
              <label>
                <span>Bandwidth Limit KB/s</span>
                <input
                  type="number"
                  min="0"
                  value={bandwidthLimit}
                  onChange={(event) => setBandwidthLimit(event.target.value)}
                  placeholder="0"
                />
              </label>
              <button type="button" onClick={() => void handleSaveBandwidthLimit()} disabled={busy}>
                Save Bandwidth Limit
              </button>
              <button type="button" className="primary" onClick={() => void handleSyncNow()} disabled={busy}>
                Sync Now
              </button>
              <button type="button" onClick={() => void handleToggleSync(!status.sync_enabled)} disabled={busy}>
                {status.sync_enabled ? "Pause Sync" : "Resume Sync"}
              </button>
              <button type="button" onClick={() => void handleQuitApp()} disabled={busy}>
                Quit App
              </button>
              <button type="button" onClick={() => void handleClearSession()} disabled={busy}>
                Clear Session
              </button>
              <button type="button" onClick={() => void handleOpenLogs()} disabled={busy}>
                Open Logs
              </button>
              <button type="button" onClick={() => void handleResetLocalSyncState()} disabled={busy}>
                Reset Local Sync State
              </button>
            </div>
            <p className="subtle-note">Closing the window keeps the sync engine running in the background.</p>
          </section>
        )}

        {(needsUnlock || status?.authenticated) && (
          <form className="panel form-panel" onSubmit={handleUnlock}>
            <div className="panel-header">
              <h2>Private Vault Unlock</h2>
              <p>Required when secure storage is disabled or after credential reset.</p>
            </div>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={unlockPassword}
                onChange={(event) => setUnlockPassword(event.target.value)}
                placeholder="Enter private vault password"
              />
            </label>
            <button type="submit" disabled={busy || unlockPassword.length < 8}>
              Unlock Vault
            </button>
          </form>
        )}

        <section className="panel">
          <div className="panel-header">
            <h2>Desktop Update</h2>
            <p>GitHub release delivery for Windows installers.</p>
          </div>
          <div className="stack">
            <button type="button" onClick={() => void handleUpdateCheck()} disabled={busy}>
              Check for Updates
            </button>
            <button type="button" onClick={() => void handleUpdateDownload()} disabled={busy || !updateInfo?.has_update}>
              Download Update
            </button>
          </div>
          <dl className="meta-list">
            <div>
              <dt>Current</dt>
              <dd>{updateInfo?.current_version ?? "0.1.0"}</dd>
            </div>
            <div>
              <dt>Latest</dt>
              <dd>{updateInfo?.latest_version ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Asset</dt>
              <dd>{updateInfo?.asset_name ?? "Release page"}</dd>
            </div>
          </dl>
        </section>
      </section>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <h2>Vault Operations</h2>
            <p>{status?.server_url ?? defaultServer}</p>
          </div>
          {message ? <p className="message">{message}</p> : null}
        </header>

        <section className="stat-grid">
          <div className="stat-card">
            <span className="stat-label">Uploads</span>
            <strong>{summary?.uploads ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Downloads</span>
            <strong>{summary?.downloads ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Deletes</span>
            <strong>{summary?.deletions ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Conflicts</span>
            <strong>{summary?.conflicts ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Transport</span>
            <strong>{status?.transport_mode === "peer" ? "Peer" : "Relay"}</strong>
            <p>{status?.peer_endpoint ?? `Port ${status?.peer_port ?? 44888}`}</p>
          </div>
          <div className="stat-card">
            <span className="stat-label">RAID Protected</span>
            <strong>{status?.raid_protected_manifests ?? 0}</strong>
            <p>{status?.raid_degraded_manifests ?? 0} degraded</p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Live Transfers</h2>
            <p>Large file sync progress for uploads and downloads.</p>
          </div>
          <div className="list-shell">
            {status?.transfers.length ? (
              status.transfers.map((transfer) => (
                <div key={transfer.id} className="transfer-card">
                  <div className="transfer-top">
                    <div>
                      <strong>{transfer.direction.toUpperCase()} · {transfer.root_kind}</strong>
                      <p>{transfer.relative_path}</p>
                    </div>
                    <span>{Math.round(transfer.percent)}%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${Math.max(4, transfer.percent)}%` }} />
                  </div>
                  <div className="transfer-meta">
                    <span>{transfer.phase}</span>
                    <span>{transfer.bytes_done} / {transfer.bytes_total || 0} bytes</span>
                    <span>{transfer.status}</span>
                  </div>
                  {transfer.message ? <p>{transfer.message}</p> : null}
                </div>
              ))
            ) : (
              <p className="empty-state">No transfers yet.</p>
            )}
          </div>
        </section>

        {status?.authenticated && (
          <section className="grid-two">
            <article className="panel">
              <div className="panel-header">
                <h2>Connection Settings</h2>
                <p>Configure local listener port and optional IP override for VPN or LAN.</p>
              </div>
              <div className="stack">
                <label>
                  <span>VPN or LAN IP Override (Optional)</span>
                  <input
                    type="text"
                    value={peerIpOverride}
                    onChange={(event) => setPeerIpOverride(event.target.value)}
                    placeholder="e.g. 10.8.0.2 or 192.168.1.50"
                  />
                  <span className="subtle-note">
                    Leave blank to autodetect IP interface routing to the server.
                  </span>
                </label>
                <label>
                  <span>Peer Seeding Port</span>
                  <input
                    type="number"
                    min="1024"
                    max="65535"
                    value={peerPort}
                    onChange={(event) => setPeerPort(event.target.value)}
                    placeholder="44888"
                  />
                </label>
                <button type="button" className="primary" onClick={() => void handleSavePeerSettings()} disabled={busy}>
                  Save Peer Settings
                </button>
              </div>
            </article>

            <article className="panel">
              <div className="panel-header">
                <h2>Active Swarm Peers</h2>
                <p>Devices registered on the same user account.</p>
              </div>
              <div className="list-shell swarm-list">
                {peerDevices.length ? (
                  peerDevices.map((device) => {
                    const isSelf = device.deviceId === status.device_id;
                    return (
                      <div key={device.deviceId} className={`peer-card ${isSelf ? "self-peer" : ""}`}>
                        <div className="peer-top">
                          <div>
                            <strong>
                              {device.deviceName} {isSelf && <span className="self-badge">(You)</span>}
                            </strong>
                            <p className="device-id">{device.deviceId}</p>
                          </div>
                          <span className={`status-badge ${device.isOnline ? "online" : "offline"}`}>
                            {device.isOnline ? "Online" : "Offline"}
                          </span>
                        </div>
                        <div className="peer-meta">
                          <span>IP Endpoint: {device.peerEndpointUrl ?? "No IP registered"}</span>
                          <span>Platform: {device.platform}</span>
                          <span>Transport: {device.peerTransport}</span>
                          <span>Reserve Capacity: {Math.round(device.reserveCapacityBytes / (1024 * 1024 * 1024))} GB ({device.reserveEnabled ? "Enabled" : "Disabled"})</span>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="empty-state">No peers found in swarm.</p>
                )}
              </div>
            </article>
          </section>
        )}

        <section className="grid-two">
          <article className="panel drive-panel">
            <div className="panel-header">
              <h2>User Vault</h2>
              <p>Encrypted private drive for owner-only files.</p>
            </div>
            <div className="drive-path">{status?.user_root ?? "Not configured yet"}</div>
          </article>

          <article className="panel drive-panel">
            <div className="panel-header">
              <h2>Share Folder</h2>
              <p>Authenticated shared drive visible to logged-in users.</p>
            </div>
            <div className="drive-path">{status?.share_root ?? "Not configured yet"}</div>
          </article>
        </section>

        <section className="grid-two">
          <article className="panel drive-panel">
            <div className="panel-header">
              <h2>Raid Reserve</h2>
              <p>Local reserve path used for parity shard hosting.</p>
            </div>
            <div className="drive-path">{status?.reserve_root ?? "Not configured yet"}</div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <h2>Reserve Health</h2>
              <p>Protection and pending repair state for private vault files.</p>
            </div>
            <div className="stat-grid compact">
              <div className="stat-card">
                <span className="stat-label">Hosted Shards</span>
                <strong>{status?.raid_hosted_shards ?? 0}</strong>
              </div>
              <div className="stat-card">
                <span className="stat-label">Pending Jobs</span>
                <strong>{status?.raid_pending_jobs ?? 0}</strong>
              </div>
            </div>
            <button type="button" className="primary" onClick={() => void handleRaidRepair()} disabled={busy}>
              Trigger RAID Repair & Rebalance
            </button>
            <p className="subtle-note">Two reserve shards on different peers are required for healthy private-vault protection.</p>
          </article>
        </section>

        <section className="grid-two">
          <article className="panel">
            <div className="panel-header">
              <h2>Recent Activity</h2>
              <p>Watcher, queue, and sync cycle events.</p>
            </div>
            <div className="list-shell">
              {status?.recent_activity.length ? (
                status.recent_activity.map((entry) => (
                  <div key={entry.id} className="list-row">
                    <div>
                      <strong>{entry.level.toUpperCase()}</strong>
                      <p>{entry.message}</p>
                    </div>
                    <time>{entry.created_at}</time>
                  </div>
                ))
              ) : (
                <p className="empty-state">No desktop activity yet.</p>
              )}
            </div>
          </article>

          <article className="panel">
            <div className="panel-header">
              <h2>Conflicts</h2>
              <p>Remote wins are preserved as local conflict copies.</p>
            </div>
            <div className="list-shell">
              {status?.conflicts.length ? (
                status.conflicts.map((entry) => (
                  <div key={entry.id} className="list-row">
                    <div>
                      <strong>{entry.root_kind}</strong>
                      <p>{entry.relative_path}</p>
                      <p>{entry.message}</p>
                    </div>
                    <time>{entry.created_at}</time>
                  </div>
                ))
              ) : (
                <p className="empty-state">No conflict records.</p>
              )}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}

export default App;
