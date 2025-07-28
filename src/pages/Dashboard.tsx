import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { User, Session } from "@supabase/supabase-js";
import { Shield, LogOut, Key, HardDrive, Users, Settings, Copy, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";

interface Profile {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
}

interface BucketLicense {
  id: string;
  license_key: string;
  bucket_size_gb: number;
  max_buckets: number;
  is_active: boolean;
  expires_at: string | null;
  encryption_method: string;
  created_at: string;
}

interface ProfileFormData {
  username: string;
  display_name: string;
  bio: string;
}

interface BucketLicenseFormData {
  bucket_size_gb: number;
  max_buckets: number;
}

const Dashboard = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [bucketLicenses, setBucketLicenses] = useState<BucketLicense[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [bucketDialogOpen, setBucketDialogOpen] = useState(false);

  const profileForm = useForm<ProfileFormData>();
  const bucketForm = useForm<BucketLicenseFormData>();

  useEffect(() => {
    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (!session) {
        navigate("/auth");
      }
    });

    // Check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (!session) {
        navigate("/auth");
      } else {
        fetchUserData();
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const fetchUserData = async () => {
    try {
      setLoading(true);
      
      // Fetch profile
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("*")
        .single();

      if (profileError) {
        console.error("Error fetching profile:", profileError);
      } else {
        setProfile(profileData);
        profileForm.reset({
          username: profileData.username || "",
          display_name: profileData.display_name || "",
          bio: profileData.bio || "",
        });
      }

      // Fetch bucket licenses
      const { data: bucketData, error: bucketError } = await supabase
        .from("bucket_licenses")
        .select("*")
        .order("created_at", { ascending: false });

      if (bucketError) {
        console.error("Error fetching bucket licenses:", bucketError);
      } else {
        setBucketLicenses(bucketData);
      }
    } catch (error) {
      console.error("Error fetching user data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast({
        title: "Error signing out",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleUpdateProfile = async (data: ProfileFormData) => {
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          username: data.username,
          display_name: data.display_name,
          bio: data.bio,
        })
        .eq("user_id", user?.id);

      if (error) {
        toast({
          title: "Error updating profile",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Profile updated",
          description: "Your profile has been successfully updated.",
        });
        setProfileDialogOpen(false);
        fetchUserData();
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  const handleCreateBucketLicense = async (data: BucketLicenseFormData) => {
    try {
      const licenseKey = `BL-${Date.now()}-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
      
      const { error } = await supabase
        .from("bucket_licenses")
        .insert({
          user_id: user?.id,
          license_key: licenseKey,
          bucket_size_gb: data.bucket_size_gb,
          max_buckets: data.max_buckets,
        });

      if (error) {
        toast({
          title: "Error creating bucket license",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Bucket license created",
          description: "Your new bucket license has been created successfully.",
        });
        setBucketDialogOpen(false);
        bucketForm.reset();
        fetchUserData();
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  const handleCopyLicenseKey = (key: string) => {
    navigator.clipboard.writeText(key);
    toast({
      title: "Copied!",
      description: "License key copied to clipboard.",
    });
  };

  const handleDeleteBucketLicense = async (id: string) => {
    try {
      const { error } = await supabase
        .from("bucket_licenses")
        .delete()
        .eq("id", id);

      if (error) {
        toast({
          title: "Error deleting bucket license",
          description: error.message,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Bucket license deleted",
          description: "The bucket license has been deleted successfully.",
        });
        fetchUserData();
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Shield className="w-12 h-12 mx-auto text-primary animate-pulse mb-4" />
          <p>Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 rounded-lg bg-gradient-primary">
                <Shield className="w-6 h-6 text-primary-foreground" />
              </div>
              <h1 className="text-xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                EncryptStore Dashboard
              </h1>
            </div>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Profile Section */}
          <div className="lg:col-span-1">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center">
                    <Users className="w-5 h-5 mr-2" />
                    Profile
                  </CardTitle>
                  <Dialog open={profileDialogOpen} onOpenChange={setProfileDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <Settings className="w-4 h-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Edit Profile</DialogTitle>
                      </DialogHeader>
                      <Form {...profileForm}>
                        <form onSubmit={profileForm.handleSubmit(handleUpdateProfile)} className="space-y-4">
                          <FormField
                            control={profileForm.control}
                            name="username"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Username</FormLabel>
                                <FormControl>
                                  <Input {...field} placeholder="Enter username" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={profileForm.control}
                            name="display_name"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Display Name</FormLabel>
                                <FormControl>
                                  <Input {...field} placeholder="Enter display name" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={profileForm.control}
                            name="bio"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Bio</FormLabel>
                                <FormControl>
                                  <Textarea {...field} placeholder="Tell us about yourself" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <Button type="submit" className="w-full">
                            Update Profile
                          </Button>
                        </form>
                      </Form>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Display Name</p>
                    <p className="font-medium">{profile?.display_name || "Not set"}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Username</p>
                    <p className="font-medium">{profile?.username || "Not set"}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Email</p>
                    <p className="font-medium">{user.email}</p>
                  </div>
                  {profile?.bio && (
                    <div>
                      <p className="text-sm text-muted-foreground">Bio</p>
                      <p className="text-sm">{profile.bio}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Bucket Licenses Section */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center">
                      <Key className="w-5 h-5 mr-2" />
                      Bucket Licenses
                    </CardTitle>
                    <CardDescription>
                      Manage your storage bucket licenses and encryption keys
                    </CardDescription>
                  </div>
                  <Dialog open={bucketDialogOpen} onOpenChange={setBucketDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="glow">
                        <Plus className="w-4 h-4 mr-2" />
                        New License
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Create Bucket License</DialogTitle>
                      </DialogHeader>
                      <Form {...bucketForm}>
                        <form onSubmit={bucketForm.handleSubmit(handleCreateBucketLicense)} className="space-y-4">
                          <FormField
                            control={bucketForm.control}
                            name="bucket_size_gb"
                            rules={{ required: "Bucket size is required", min: { value: 1, message: "Minimum size is 1GB" } }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Bucket Size (GB)</FormLabel>
                                <FormControl>
                                  <Input {...field} type="number" min="1" placeholder="Enter bucket size in GB" onChange={(e) => field.onChange(parseInt(e.target.value))} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <FormField
                            control={bucketForm.control}
                            name="max_buckets"
                            rules={{ required: "Max buckets is required", min: { value: 1, message: "Minimum is 1 bucket" } }}
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Maximum Buckets</FormLabel>
                                <FormControl>
                                  <Input {...field} type="number" min="1" placeholder="Enter maximum number of buckets" onChange={(e) => field.onChange(parseInt(e.target.value))} />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                          <Button type="submit" className="w-full">
                            Create License
                          </Button>
                        </form>
                      </Form>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {bucketLicenses.length === 0 ? (
                    <div className="text-center py-8">
                      <HardDrive className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                      <p className="text-muted-foreground">No bucket licenses yet</p>
                      <p className="text-sm text-muted-foreground">Create your first bucket license to get started</p>
                    </div>
                  ) : (
                    bucketLicenses.map((license) => (
                      <Card key={license.id} className="border-border/50">
                        <CardContent className="pt-6">
                          <div className="flex items-start justify-between">
                            <div className="space-y-2">
                              <div className="flex items-center space-x-2">
                                <Badge variant={license.is_active ? "default" : "secondary"}>
                                  {license.is_active ? "Active" : "Inactive"}
                                </Badge>
                                <span className="text-sm text-muted-foreground">
                                  {license.encryption_method}
                                </span>
                              </div>
                              <div>
                                <p className="text-sm text-muted-foreground">License Key</p>
                                <div className="flex items-center space-x-2">
                                  <code className="text-sm bg-muted px-2 py-1 rounded">
                                    {license.license_key}
                                  </code>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleCopyLicenseKey(license.license_key)}
                                  >
                                    <Copy className="w-4 h-4" />
                                  </Button>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div>
                                  <p className="text-muted-foreground">Bucket Size</p>
                                  <p className="font-medium">{license.bucket_size_gb} GB</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground">Max Buckets</p>
                                  <p className="font-medium">{license.max_buckets}</p>
                                </div>
                              </div>
                              <div>
                                <p className="text-muted-foreground text-xs">
                                  Created: {new Date(license.created_at).toLocaleDateString()}
                                </p>
                              </div>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteBucketLicense(license.id)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;