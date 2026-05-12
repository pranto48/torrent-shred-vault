import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Database, RefreshCw, Shield, UploadCloud, Users } from "lucide-react";
import { api, formatBytes, UpdateCheck, UpdateHistory, UpdateStatus } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type AdminUser = {
  id: string;
  email: string;
  role: "admin" | "user";
  created_at?: string;
  used_bytes: string | number;
  user_quota_bytes: string | number;
};

const Admin = () => {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateHistory[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && (!user || !isAdmin)) navigate("/auth");
  }, [loading, user, isAdmin, navigate]);

  const loadAdmin = async () => {
    const [userResult, statusResult] = await Promise.all([api.adminUsers(), api.updateStatus()]);
    setUsers(userResult.users);
    setUpdateStatus(statusResult.updater);
    setHistory(statusResult.history);
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
              <p className="text-muted-foreground">Users, quotas, and Docker system updates</p>
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

        <div className="mb-8 grid gap-4 md:grid-cols-3">
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
              <CardTitle className="text-sm font-medium">Stored Data</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatBytes(users.reduce((sum, item) => sum + Number(item.used_bytes), 0))}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Updater</CardTitle>
              <UploadCloud className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <Badge>{updateStatus?.status ?? "unknown"}</Badge>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="updates">System Update</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>User Management</CardTitle>
                <CardDescription>Docker-local users and their 5GB quota usage.</CardDescription>
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
                    <Badge variant={item.role === "admin" ? "default" : "secondary"}>{item.role}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="updates" className="mt-6">
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
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
};

export default Admin;
