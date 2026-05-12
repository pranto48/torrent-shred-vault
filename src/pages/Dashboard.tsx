import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Shield, UserCog } from "lucide-react";
import { FileManager } from "@/components/FileManager";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

const Dashboard = () => {
  const { user, isAdmin, loading, logout } = useAuth();
  const navigate = useNavigate();

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
        <FileManager />
      </main>
    </div>
  );
};

export default Dashboard;
