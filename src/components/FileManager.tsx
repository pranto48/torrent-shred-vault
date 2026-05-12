import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { Download, File, Folder, FolderPlus, HardDrive, RefreshCw, Share2, Trash2, Upload } from "lucide-react";
import { api, formatBytes, saveBlob, Vault, VaultItem, VaultQuota } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

function parentOf(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

export const FileManager = () => {
  const { toast } = useToast();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [quota, setQuota] = useState<VaultQuota | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<VaultItem[]>([]);
  const [sharedItems, setSharedItems] = useState<VaultItem[]>([]);
  const [vaultPassword, setVaultPassword] = useState("");
  const [folderName, setFolderName] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const selectedVault = useMemo(() => vaults.find((vault) => vault.id === selectedVaultId), [vaults, selectedVaultId]);
  const usedPercent = quota ? Math.min(100, (Number(quota.usedBytes) / Number(quota.package.user_quota_bytes)) * 100) : 0;

  const loadVaults = async () => {
    const result = await api.vaults();
    setVaults(result.vaults);
    setQuota(result.quota);
    setSelectedVaultId((current) => current || result.vaults[0]?.id || "");
  };

  const loadFiles = async () => {
    if (!selectedVaultId) return;
    setLoading(true);
    try {
      const result = await api.listFiles(selectedVaultId, currentPath);
      setItems(result.items);
    } catch (error) {
      toast({ title: "File listing failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const loadSharedFiles = async () => {
    try {
      const result = await api.sharedFiles("/");
      setSharedItems(result.items);
    } catch (error) {
      toast({ title: "Shared files failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    }
  };

  useEffect(() => {
    loadVaults().catch((error) =>
      toast({ title: "Vault load failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" }),
    );
  }, []);

  useEffect(() => {
    loadFiles();
  }, [selectedVaultId, currentPath]);

  useEffect(() => {
    loadSharedFiles();
  }, []);

  const createFolder = async () => {
    if (!selectedVaultId || !folderName.trim()) return;
    try {
      await api.createFolder(selectedVaultId, currentPath, folderName.trim());
      setFolderName("");
      await loadFiles();
    } catch (error) {
      toast({ title: "Folder creation failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    }
  };

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedVaultId) return;
    if (!vaultPassword) {
      toast({ title: "Vault password required", description: "Enter your web account password before uploading.", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      const result = await api.uploadFile(selectedVaultId, currentPath, vaultPassword, file);
      setQuota(result.quota);
      await loadFiles();
      await loadSharedFiles();
      toast({ title: "Upload complete", description: `${file.name} was encrypted and stored.` });
    } catch (error) {
      toast({ title: "Upload failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const downloadOwn = async (item: VaultItem) => {
    if (!vaultPassword) {
      toast({ title: "Vault password required", description: "Enter your web account password before downloading.", variant: "destructive" });
      return;
    }
    try {
      saveBlob(await api.downloadFile(item, vaultPassword), item.name);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    }
  };

  const downloadShared = async (item: VaultItem) => {
    try {
      saveBlob(await api.downloadSharedFile(item), item.name);
    } catch (error) {
      toast({ title: "Shared download failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    }
  };

  const deleteItem = async (item: VaultItem) => {
    try {
      await api.deleteFile(item.id);
      await loadFiles();
      await loadVaults();
      await loadSharedFiles();
    } catch (error) {
      toast({ title: "Delete failed", description: error instanceof Error ? error.message : "Request failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            10GB Vault Package
          </CardTitle>
          <CardDescription>5GB user data quota with 5GB reserved for raid/torrent sync planning.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <span>Total: {formatBytes(quota?.package.total_quota_bytes)}</span>
            <span>User quota: {formatBytes(quota?.package.user_quota_bytes)}</span>
            <span>Raid reserve: {formatBytes(quota?.package.raid_reserve_bytes)}</span>
            <span>Used: {formatBytes(quota?.usedBytes)}</span>
          </div>
          <Progress value={usedPercent} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vault Explorer</CardTitle>
          <CardDescription>Private and share vault files are encrypted before MinIO storage.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={selectedVault?.type ?? "user_vault"}
            onValueChange={(type) => {
              const next = vaults.find((vault) => vault.type === type);
              if (next) {
                setSelectedVaultId(next.id);
                setCurrentPath("/");
              }
            }}
          >
            <TabsList>
              <TabsTrigger value="user_vault">User Vault</TabsTrigger>
              <TabsTrigger value="share_vault">Share Vault</TabsTrigger>
            </TabsList>
            <TabsContent value={selectedVault?.type ?? "user_vault"} className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  <Label htmlFor="vault-password">Vault password</Label>
                  <Input
                    id="vault-password"
                    type="password"
                    value={vaultPassword}
                    onChange={(event) => setVaultPassword(event.target.value)}
                    placeholder="Required for upload/download"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <Button variant="outline" onClick={() => loadFiles()} disabled={loading}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" disabled={currentPath === "/"} onClick={() => setCurrentPath(parentOf(currentPath))}>
                  Up
                </Button>
                <code className="rounded bg-muted px-3 py-2 text-sm">{currentPath}</code>
              </div>

              <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
                <Input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="New folder name" />
                <Button variant="outline" onClick={createFolder}>
                  <FolderPlus className="h-4 w-4" />
                  Folder
                </Button>
                <Button asChild disabled={uploading}>
                  <label className="cursor-pointer">
                    <Upload className="h-4 w-4" />
                    {uploading ? "Uploading" : "Upload"}
                    <input className="hidden" type="file" onChange={uploadFile} />
                  </label>
                </Button>
              </div>

              <div className="rounded-md border">
                {items.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">{loading ? "Loading files..." : "No files in this folder"}</div>
                ) : (
                  items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 border-b p-3 last:border-b-0">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => item.item_type === "folder" && setCurrentPath(item.path)}
                      >
                        {item.item_type === "folder" ? <Folder className="h-5 w-5 text-primary" /> : <File className="h-5 w-5 text-muted-foreground" />}
                        <span className="truncate font-medium">{item.name}</span>
                      </button>
                      <span className="hidden text-sm text-muted-foreground sm:inline">{item.item_type === "file" ? formatBytes(item.size_bytes) : "Folder"}</span>
                      {item.item_type === "file" && (
                        <Button variant="ghost" size="icon" onClick={() => downloadOwn(item)} title="Download">
                          <Download className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => deleteItem(item)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5" />
            Shared Folder
          </CardTitle>
          <CardDescription>Files uploaded to any user&apos;s Share Vault are visible to all logged-in users.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            {sharedItems.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No shared files yet</div>
            ) : (
              sharedItems.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 border-b p-3 last:border-b-0">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {item.item_type === "folder" ? <Folder className="h-5 w-5 text-primary" /> : <File className="h-5 w-5 text-muted-foreground" />}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{item.owner_email}</p>
                    </div>
                  </div>
                  <span className="hidden text-sm text-muted-foreground sm:inline">{item.item_type === "file" ? formatBytes(item.size_bytes) : "Folder"}</span>
                  {item.item_type === "file" && (
                    <Button variant="ghost" size="icon" onClick={() => downloadShared(item)} title="Download shared file">
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
