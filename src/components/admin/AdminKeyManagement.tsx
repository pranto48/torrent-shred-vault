import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Key, Copy, RefreshCw, Plus } from 'lucide-react';

interface EncryptKey {
  id: string;
  user_id: string;
  license_key: string;
  bucket_size_gb: number;
  max_buckets: number;
  is_active: boolean;
  encryption_method: string;
  created_at: string;
  profiles?: {
    display_name: string;
    email: string;
  };
}

export const AdminKeyManagement = () => {
  const [keys, setKeys] = useState<EncryptKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newKeyData, setNewKeyData] = useState({
    bucket_size_gb: 1,
    max_buckets: 5,
    encryption_method: 'AES-256-GCM'
  });
  const { toast } = useToast();

  const fetchKeys = async () => {
    try {
      const { data: keysData, error: keysError } = await supabase
        .from('bucket_licenses')
        .select('*')
        .order('created_at', { ascending: false });

      if (keysError) throw keysError;

      const keysWithProfiles = await Promise.all(
        (keysData || []).map(async (key) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('display_name, email')
            .eq('user_id', key.user_id)
            .single();

          return {
            ...key,
            profiles: profile || { display_name: '', email: '' }
          };
        })
      );

      setKeys(keysWithProfiles);
    } catch (error) {
      console.error('Error fetching encryption keys:', error);
      toast({
        title: "Error",
        description: "Failed to fetch encryption keys",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const generateNewKey = () => {
    return 'BL-' + Math.random().toString(36).substr(2, 8).toUpperCase();
  };

  const regenerateKey = async (keyId: string) => {
    try {
      const newKey = generateNewKey();
      const { error } = await supabase
        .from('bucket_licenses')
        .update({ license_key: newKey })
        .eq('id', keyId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "License key regenerated successfully",
      });

      fetchKeys();
    } catch (error) {
      console.error('Error regenerating key:', error);
      toast({
        title: "Error",
        description: "Failed to regenerate license key",
        variant: "destructive",
      });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied!",
      description: "License key copied to clipboard",
    });
  };

  const toggleKeyStatus = async (keyId: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase
        .from('bucket_licenses')
        .update({ is_active: !currentStatus })
        .eq('id', keyId);

      if (error) throw error;

      toast({
        title: "Success",
        description: `License key ${!currentStatus ? 'activated' : 'deactivated'}`,
      });

      fetchKeys();
    } catch (error) {
      console.error('Error updating key status:', error);
      toast({
        title: "Error",
        description: "Failed to update license key status",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    fetchKeys();
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
          <Key className="h-5 w-5" />
          EncryptStore Key Management
        </CardTitle>
        <CardDescription>
          Manage encryption keys and license distribution
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-full">
                  <Key className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm font-medium">{key.license_key}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(key.license_key)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {key.profiles?.display_name || key.profiles?.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {key.encryption_method} • {key.bucket_size_gb}GB • {key.max_buckets} buckets
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Created: {new Date(key.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-3">
                <Badge variant={key.is_active ? 'default' : 'destructive'}>
                  {key.is_active ? 'Active' : 'Inactive'}
                </Badge>
                
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => regenerateKey(key.id)}
                  title="Regenerate Key"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
                
                <Button
                  variant={key.is_active ? "destructive" : "default"}
                  size="sm"
                  onClick={() => toggleKeyStatus(key.id, key.is_active)}
                >
                  {key.is_active ? 'Deactivate' : 'Activate'}
                </Button>
              </div>
            </div>
          ))}
          
          {keys.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No encryption keys found
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};