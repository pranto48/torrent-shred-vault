import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Shield, UserCog } from "lucide-react";
import { FileManager } from "@/components/FileManager";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const Dashboard = () => {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate("/auth");
  }, [loading, user, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Shield className="h-10 w-10 animate-pulse text-primary" />
      </div>
    );
  }

  if (!user) return null;

  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ title: "Password mismatch", description: "New password and confirm password must match.", variant: "destructive" });
      return;
    }
    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Password updated", description: "Your vault password and account password were updated." });
    } catch (error) {
      toast({
        title: "Password change failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/60">
        <div className="container mx-auto flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary p-2">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Torrent Shred Vault</h1>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button variant="outline" onClick={() => navigate("/admin")}>
                <UserCog className="h-4 w-4" />
                Admin
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                logout();
                navigate("/auth");
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8">
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Account Password</CardTitle>
            <CardDescription>
              Fresh Docker installs now seed the default admin account with password <code>password</code>. Change it here after the first login.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" onSubmit={handleChangePassword}>
              <div className="grid gap-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}>
                  {changingPassword ? "Updating..." : "Change Password"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <FileManager />
      </main>
    </div>
  );
};

export default Dashboard;
