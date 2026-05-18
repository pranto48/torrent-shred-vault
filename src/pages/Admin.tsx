import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArchiveRestore,
  Database,
  Download,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Network,
  RefreshCw,
  Settings,
  Shield,
  ShieldCheck,
  Upload,
  UploadCloud,
  Users,
} from "lucide-react";
import {
  AdminRaidStatus,
  BackupRecord,
  BackupStatus,
  api,
  formatBytes,
  saveBlob,
  UpdateCheck,
  UpdateHistory,
  UpdateStatus,
} from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "user";
  created_at?: string;
  used_bytes: string | number;
  user_quota_bytes: string | number;
};

type AdminSection = "overview" | "users" | "raid" | "backups" | "updates" | "settings";

const navItems: Array<{ id: AdminSection; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "Users", icon: Users },
  { id: "raid", label: "RAID Reserve", icon: Network },
  { id: "backups", label: "Backups", icon: ArchiveRestore },
  { id: "updates", label: "System Update", icon: UploadCloud },
  { id: "settings", label: "Settings", icon: Settings },
];

const Admin = () => {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [section, setSection] = useState<AdminSection>("overview");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateHistory[]>([]);
  const [raidStatus, setRaidStatus] = useState<AdminRaidStatus | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  useEffect(() => {
    if (!loading && (!user || !isAdmin)) navigate("/auth");
  }, [loading, user, isAdmin, navigate]);

  const totalStored = useMemo(() => users.reduce((sum, item) => sum + Number(item.used_bytes), 0), [users]);

  const loadAdmin = async () => {
    const [userResult, statusResult, raidResult, backupResult] = await Promise.all([
      api.adminUsers(),
      api.updateStatus(),
      api.adminRaidStatus(),
      api.adminBackups(),
    ]);
    setUsers(userResult.users);
    setUpdateStatus(statusResult.updater);
    setHistory(statusResult.history);
    setRaidStatus(raidResult);
    setBackups(backupResult.backups);
    setBackupStatus(backupResult.status);
  };

  const loadBackups = async () => {
    const result = await api.adminBackups();
    setBackups(result.backups);
    setBackupStatus(result.status);
  };

  useEffect(() => {
    if (user && isAdmin) {
      loadAdmin().catch((error) =>
        toast({ title: "Admin load failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" }),
      );
    }
  }, [user, isAdmin]);

  const checkForUpdate = async () => {
    setBusy(true);
    try {
      const result = await api.updateCheck();
      setUpdateCheck(result);
      await loadAdmin();
    } catch (error) {
      toast({ title: "Update check failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const applyUpdate = async () => {
    setBusy(true);
    try {
      const result = await api.updateApply();
      setUpdateStatus(result);
      await loadAdmin();
      toast({ title: "Update started", description: result.message ?? "Docker updater is rebuilding the app." });
    } catch (error) {
      toast({ title: "Update failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const createBackup = async () => {
    setBusy(true);
    try {
      await api.adminCreateBackup();
      await loadBackups();
      toast({ title: "Backup created", description: "Postgres and config manifest backup is stored on the Docker backup volume." });
    } catch (error) {
      toast({ title: "Backup failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async (backup: BackupRecord) => {
    setBusy(true);
    try {
      const blob = await api.adminDownloadBackup(backup.id);
      saveBlob(blob, backup.fileName || `${backup.id}.tsvbackup`);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const uploadBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      await api.adminUploadBackup(file);
      await loadBackups();
      toast({ title: "Backup uploaded", description: "The backup is available for restore." });
    } catch (error) {
      toast({ title: "Upload failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async (backup: BackupRecord) => {
    const confirmed = window.confirm(
      `Restore ${backup.fileName}? The API will enter maintenance restore mode and restart web/API containers after the database restore.`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.adminRestoreBackup(backup.id);
      await loadAdmin();
      toast({ title: "Restore finished", description: "Database restore completed. Containers may take a moment to restart." });
    } catch (error) {
      toast({ title: "Restore failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const resetUserPassword = async () => {
    if (!resetTarget) return;
    setBusy(true);
    try {
      await api.adminResetUserPassword(resetTarget.id, resetPassword);
      toast({
        title: "User password reset",
        description: `${resetTarget.email} can now unlock with the new password.`,
      });
      setResetTarget(null);
      setResetPassword("");
    } catch (error) {
      toast({
        title: "Recovery reset failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const runRaidRepair = async (userId?: string) => {
    setBusy(true);
    try {
      await api.adminRaidRepair(userId);
      const result = await api.adminRaidStatus();
      setRaidStatus(result);
      toast({ title: "RAID maintenance queued", description: userId ? "User reserve assignments were refreshed." : "All reserve assignments were refreshed." });
    } catch (error) {
      toast({ title: "RAID maintenance failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Shield className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

  if (!user || !isAdmin) return null;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-6 py-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="outline" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Button>
            <div>
              <h1 className="text-3xl font-bold">Admin Panel</h1>
              <p className="text-muted-foreground">Operator controls for users, RAID reserve, backups, and Docker updates.</p>
            </div>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              logout();
              navigate("/auth");
            }}
          >
            Sign Out
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <aside className="space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <Button
                  key={item.id}
                  variant={active ? "default" : "ghost"}
                  className="w-full justify-start"
                  onClick={() => setSection(item.id)}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Button>
              );
            })}
          </aside>

          <main className="space-y-6">
            {section === "overview" && (
              <>
                <div className="grid gap-4 md:grid-cols-4">
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Users</CardTitle>
                      <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{users.length}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Metadata Usage</CardTitle>
                      <Database className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{formatBytes(totalStored)}</div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">Backups</CardTitle>
                      <ArchiveRestore className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{backups.length}</div>
                      <p className="text-xs text-muted-foreground">{backupStatus?.status ?? "idle"}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium">RAID Protected</CardTitle>
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">{raidStatus?.totals.protected ?? 0}</div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>System State</CardTitle>
                    <CardDescription>Current Docker control-plane status.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-3">
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Updater</p>
                      <Badge>{updateStatus?.status ?? "unknown"}</Badge>
                    </div>
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Backup Service</p>
                      <Badge variant={backupStatus?.status === "failed" ? "destructive" : "secondary"}>{backupStatus?.status ?? "unknown"}</Badge>
                    </div>
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Reserve Peers</p>
                      <p className="text-xl font-semibold">{raidStatus?.totals.activeReservePeers ?? 0}</p>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {section === "users" && (
              <Card>
                <CardHeader>
                  <CardTitle>User Management</CardTitle>
                  <CardDescription>Docker-local users, 5GB user quota usage, and vault recovery reset.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {users.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
                      <div>
                        <p className="font-medium">{item.email}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatBytes(item.used_bytes)} of {formatBytes(item.user_quota_bytes)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={item.role === "admin" ? "default" : "secondary"}>{item.role}</Badge>
                        <Button variant="outline" onClick={() => setResetTarget(item)}>
                          <KeyRound className="h-4 w-4" />
                          Reset Unlock
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {section === "raid" && (
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle>RAID Reserve</CardTitle>
                      <CardDescription>Peer reserve placement, quorum state, and repair jobs for private vault files.</CardDescription>
                    </div>
                    <Button variant="outline" onClick={() => runRaidRepair()} disabled={busy}>
                      <RefreshCw className="h-4 w-4" />
                      Repair All
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-5">
                    <div className="rounded-md border p-3">
                      <p className="text-sm text-muted-foreground">Reserve Used</p>
                      <p className="text-xl font-semibold">{formatBytes(raidStatus?.totals.reserveUsedBytes ?? 0)}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-sm text-muted-foreground">Active Peers</p>
                      <p className="text-xl font-semibold">{raidStatus?.totals.activeReservePeers ?? 0}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-sm text-muted-foreground">Manifests</p>
                      <p className="text-xl font-semibold">{raidStatus?.totals.manifests ?? 0}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-sm text-muted-foreground">Protected</p>
                      <p className="text-xl font-semibold">{raidStatus?.totals.protected ?? 0}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-sm text-muted-foreground">Degraded</p>
                      <p className="text-xl font-semibold">{raidStatus?.totals.degraded ?? 0}</p>
                    </div>
                  </div>

                  <div className="space-y-3">
                    {raidStatus?.users.length ? (
                      raidStatus.users.map((entry) => (
                        <div key={entry.user.id} className="rounded-md border p-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <p className="font-medium">{entry.user.email}</p>
                              <p className="text-sm text-muted-foreground">
                                {entry.status.summary.protected} protected, {entry.status.summary.degraded} degraded, {entry.status.activeReservePeers} active peers
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={entry.status.summary.degraded ? "destructive" : "secondary"}>
                                {entry.status.summary.degraded ? "degraded" : "healthy"}
                              </Badge>
                              <Button variant="outline" onClick={() => runRaidRepair(entry.user.id)} disabled={busy}>
                                <Network className="h-4 w-4" />
                                Repair
                              </Button>
                            </div>
                          </div>
                          <div className="mt-3 grid gap-2">
                            {entry.status.manifests.length ? (
                              entry.status.manifests.slice(0, 8).map((manifest) => (
                                <div key={manifest.manifest_id} className="grid gap-2 rounded border p-3 md:grid-cols-[1fr_auto_auto]">
                                  <span className="break-all font-mono text-sm">{manifest.path}</span>
                                  <Badge variant={manifest.status === "protected" ? "secondary" : "destructive"}>{manifest.status}</Badge>
                                  <span className="text-sm text-muted-foreground">
                                    {manifest.shards.filter((shard) => shard.sources.length > 0).length}/{manifest.shards.length} shards
                                  </span>
                                </div>
                              ))
                            ) : (
                              <p className="text-sm text-muted-foreground">No RAID manifests yet.</p>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">No RAID status available.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {section === "backups" && (
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle>Database and Config Backups</CardTitle>
                      <CardDescription>Encrypted Postgres plus config manifest backups. Vault file bytes and MinIO blobs are excluded.</CardDescription>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => loadBackups()} disabled={busy}>
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                      </Button>
                      <Button onClick={createBackup} disabled={busy}>
                        <Database className="h-4 w-4" />
                        Create Backup
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-[1fr_280px]">
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Backup Service Status</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge variant={backupStatus?.status === "failed" ? "destructive" : "secondary"}>{backupStatus?.status ?? "unknown"}</Badge>
                        <span className="text-sm text-muted-foreground">{backupStatus?.message ?? "No status message."}</span>
                      </div>
                      {backupStatus?.error && <p className="mt-2 text-sm text-destructive">{backupStatus.error}</p>}
                    </div>
                    <div className="rounded-md border p-4">
                      <Label htmlFor="backup-upload">Upload backup file</Label>
                      <Input id="backup-upload" className="mt-2" type="file" accept=".tsvbackup,application/octet-stream" onChange={uploadBackup} disabled={busy} />
                    </div>
                  </div>

                  <div className="space-y-3">
                    {backups.length ? (
                      backups.map((backup) => (
                        <div key={backup.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
                          <div>
                            <p className="font-medium">{backup.fileName}</p>
                            <p className="text-sm text-muted-foreground">
                              {backup.createdAt ? new Date(backup.createdAt).toLocaleString() : "Unknown date"} - {formatBytes(backup.sizeBytes)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Contents: {backup.manifest?.contents?.join(", ") ?? "unknown"}; excludes {backup.manifest?.excludes?.join(", ") ?? "vault blobs"}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button variant="outline" onClick={() => downloadBackup(backup)} disabled={busy}>
                              <Download className="h-4 w-4" />
                              Download
                            </Button>
                            <Button variant="destructive" onClick={() => restoreBackup(backup)} disabled={busy}>
                              <ArchiveRestore className="h-4 w-4" />
                              Restore
                            </Button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="rounded-md border p-4 text-sm text-muted-foreground">No backups have been created yet.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {section === "updates" && (
              <Card>
                <CardHeader>
                  <CardTitle>System Update</CardTitle>
                  <CardDescription>Pulls GitHub main, rebuilds Docker images, and recreates containers while keeping volumes.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={checkForUpdate} disabled={busy}>
                      <RefreshCw className="h-4 w-4" />
                      Check Update
                    </Button>
                    <Button onClick={applyUpdate} disabled={busy}>
                      <UploadCloud className="h-4 w-4" />
                      Apply Update
                    </Button>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Repository</p>
                      <p className="break-all font-mono text-sm">{updateCheck?.repoUrl ?? updateStatus?.repoUrl ?? "not checked"}</p>
                      <p className="mt-2 text-sm text-muted-foreground">Branch: {updateCheck?.branch ?? updateStatus?.branch ?? "main"}</p>
                    </div>
                    <div className="rounded-md border p-4">
                      <p className="text-sm text-muted-foreground">Status</p>
                      <p className="font-medium">{updateStatus?.message ?? updateStatus?.status ?? "idle"}</p>
                      {updateCheck && <p className="mt-2 text-sm">{updateCheck.hasUpdate ? "Update available" : "Already up to date"}</p>}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="font-medium">History</h3>
                    {history.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No update history yet.</p>
                    ) : (
                      history.map((item) => (
                        <div key={item.id} className="rounded-md border p-3">
                          <div className="flex items-center justify-between gap-2">
                            <Badge>{item.status}</Badge>
                            <span className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString()}</span>
                          </div>
                          {item.message && <p className="mt-2 text-sm">{item.message}</p>}
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {section === "settings" && (
              <Card>
                <CardHeader>
                  <CardTitle>Settings</CardTitle>
                  <CardDescription>Current operating rules for this Docker control plane.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border p-4">
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-muted-foreground" />
                      <p className="font-medium">Vault storage policy</p>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Docker stores users, vault keys, quotas, peer manifests, backup metadata, and RAID state. Peer mode should not store new vault file bytes on Docker.
                    </p>
                  </div>
                  <div className="rounded-md border p-4">
                    <div className="flex items-center gap-2">
                      <Network className="h-4 w-4 text-muted-foreground" />
                      <p className="font-medium">Peer sync policy</p>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Remote desktop sync requires routable LAN or VPN connectivity. Docker brokers auth, discovery, quotas, and shard state.
                    </p>
                  </div>
                  <div className="rounded-md border p-4">
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      <p className="font-medium">Backup policy</p>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Backups include Postgres and a non-secret config manifest only. MinIO and vault blob bytes are excluded by default.
                    </p>
                  </div>
                  <div className="rounded-md border p-4">
                    <div className="flex items-center gap-2">
                      <Upload className="h-4 w-4 text-muted-foreground" />
                      <p className="font-medium">Update policy</p>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Docker web updates and desktop GitHub Release updates are separate flows.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </main>
        </div>
      </div>

      <Dialog open={!!resetTarget} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset User Unlock Password</DialogTitle>
            <DialogDescription>
              This reassigns the user account password and vault unlock password through the Docker portal recovery key.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border p-3 text-sm text-muted-foreground">{resetTarget?.email}</div>
            <div className="space-y-2">
              <Label htmlFor="reset-password">New password</Label>
              <Input id="reset-password" type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button onClick={resetUserPassword} disabled={busy || resetPassword.length < 8}>
              Apply Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Admin;
