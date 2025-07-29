import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Database, Edit, Trash2, Plus } from 'lucide-react';

interface BucketLicense {
  id: string;
  user_id: string;
  license_key: string;
  bucket_size_gb: number;
  max_buckets: number;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  profiles?: {
    display_name: string;
    email: string;
  };
}

export const AdminBucketManagement = () => {
  const [buckets, setBuckets] = useState<BucketLicense[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingBucket, setEditingBucket] = useState<BucketLicense | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { toast } = useToast();

  const fetchBuckets = async () => {
    try {
      // First get all bucket licenses
      const { data: bucketData, error: bucketError } = await supabase
        .from('bucket_licenses')
        .select('*')
        .order('created_at', { ascending: false });

      if (bucketError) throw bucketError;

      // Then get profile data for each bucket
      const bucketsWithProfiles = await Promise.all(
        (bucketData || []).map(async (bucket) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('display_name, email')
            .eq('user_id', bucket.user_id)
            .single();

          return {
            ...bucket,
            profiles: profile || { display_name: '', email: '' }
          };
        })
      );

      setBuckets(bucketsWithProfiles);
    } catch (error) {
      console.error('Error fetching bucket licenses:', error);
      toast({
        title: "Error",
        description: "Failed to fetch bucket licenses",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const updateBucket = async (bucket: Partial<BucketLicense>) => {
    try {
      const { error } = await supabase
        .from('bucket_licenses')
        .update({
          bucket_size_gb: bucket.bucket_size_gb,
          max_buckets: bucket.max_buckets,
          is_active: bucket.is_active,
          expires_at: bucket.expires_at
        })
        .eq('id', bucket.id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Bucket license updated successfully",
      });

      setIsDialogOpen(false);
      setEditingBucket(null);
      fetchBuckets();
    } catch (error) {
      console.error('Error updating bucket:', error);
      toast({
        title: "Error",
        description: "Failed to update bucket license",
        variant: "destructive",
      });
    }
  };

  const deleteBucket = async (bucketId: string) => {
    try {
      const { error } = await supabase
        .from('bucket_licenses')
        .delete()
        .eq('id', bucketId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Bucket license deleted successfully",
      });

      fetchBuckets();
    } catch (error) {
      console.error('Error deleting bucket:', error);
      toast({
        title: "Error",
        description: "Failed to delete bucket license",
        variant: "destructive",
      });
    }
  };

  const toggleBucketStatus = async (bucketId: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('bucket_licenses')
        .update({ is_active: !currentStatus })
        .eq('id', bucketId);

      if (error) throw error;

      toast({
        title: "Success",
        description: `Bucket license ${!currentStatus ? 'activated' : 'deactivated'}`,
      });

      fetchBuckets();
    } catch (error) {
      console.error('Error updating bucket status:', error);
      toast({
        title: "Error",
        description: "Failed to update bucket status",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    fetchBuckets();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Bucket License Management
        </CardTitle>
        <CardDescription>
          Manage storage bucket licenses and quotas
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {buckets.map((bucket) => (
            <div key={bucket.id} className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-full">
                  <Database className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="font-medium">{bucket.license_key}</p>
                  <p className="text-sm text-muted-foreground">
                    {bucket.profiles?.display_name || bucket.profiles?.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {bucket.bucket_size_gb}GB • {bucket.max_buckets} buckets max
                  </p>
                  {bucket.expires_at && (
                    <p className="text-xs text-muted-foreground">
                      Expires: {new Date(bucket.expires_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <Badge variant={bucket.is_active ? 'default' : 'destructive'}>
                  {bucket.is_active ? 'Active' : 'Inactive'}
                </Badge>
                
                <Dialog open={isDialogOpen && editingBucket?.id === bucket.id} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingBucket(bucket)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Edit Bucket License</DialogTitle>
                      <DialogDescription>
                        Modify bucket license settings
                      </DialogDescription>
                    </DialogHeader>
                    
                    {editingBucket && (
                      <div className="space-y-4">
                        <div>
                          <Label htmlFor="bucketSize">Bucket Size (GB)</Label>
                          <Input
                            id="bucketSize"
                            type="number"
                            value={editingBucket.bucket_size_gb}
                            onChange={(e) => setEditingBucket({
                              ...editingBucket,
                              bucket_size_gb: parseInt(e.target.value)
                            })}
                          />
                        </div>
                        
                        <div>
                          <Label htmlFor="maxBuckets">Max Buckets</Label>
                          <Input
                            id="maxBuckets"
                            type="number"
                            value={editingBucket.max_buckets}
                            onChange={(e) => setEditingBucket({
                              ...editingBucket,
                              max_buckets: parseInt(e.target.value)
                            })}
                          />
                        </div>
                        
                        <div>
                          <Label htmlFor="expiresAt">Expires At (optional)</Label>
                          <Input
                            id="expiresAt"
                            type="datetime-local"
                            value={editingBucket.expires_at ? 
                              new Date(editingBucket.expires_at).toISOString().slice(0, 16) : ''
                            }
                            onChange={(e) => setEditingBucket({
                              ...editingBucket,
                              expires_at: e.target.value ? new Date(e.target.value).toISOString() : null
                            })}
                          />
                        </div>
                        
                        <div className="flex gap-2">
                          <Button onClick={() => updateBucket(editingBucket)}>
                            Update License
                          </Button>
                          <Button variant="outline" onClick={() => {
                            setIsDialogOpen(false);
                            setEditingBucket(null);
                          }}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </DialogContent>
                </Dialog>
                
                <Button
                  variant={bucket.is_active ? "destructive" : "default"}
                  size="sm"
                  onClick={() => toggleBucketStatus(bucket.id, bucket.is_active)}
                >
                  {bucket.is_active ? 'Deactivate' : 'Activate'}
                </Button>
                
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteBucket(bucket.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          
          {buckets.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No bucket licenses found
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};