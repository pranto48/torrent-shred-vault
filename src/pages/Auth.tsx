import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Lock, Mail } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Auth = () => {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) navigate("/dashboard");
  }, [user, navigate]);

  const submit = async (mode: "login" | "register") => {
    setLoading(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
      navigate("/dashboard");
    } catch (error) {
      toast({
        title: mode === "login" ? "Sign in failed" : "Account creation failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-primary">
            <Shield className="h-8 w-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold">Torrent Shred Vault</h1>
          <p className="mt-2 text-muted-foreground">Local Docker vault authentication</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Vault Access</CardTitle>
            <CardDescription>Use the Docker-local account controlled by this server.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Sign In</TabsTrigger>
                <TabsTrigger value="register">Create User</TabsTrigger>
              </TabsList>

              {(["login", "register"] as const).map((mode) => (
                <TabsContent key={mode} value={mode} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor={`${mode}-email`}>Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input id={`${mode}-email`} className="pl-10" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${mode}-password`}>Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id={`${mode}-password`}
                        className="pl-10"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    </div>
                  </div>
                  <Button className="w-full" disabled={loading} onClick={() => submit(mode)}>
                    {loading ? "Working..." : mode === "login" ? "Sign In" : "Create Account"}
                  </Button>
                </TabsContent>
              ))}
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Auth;
