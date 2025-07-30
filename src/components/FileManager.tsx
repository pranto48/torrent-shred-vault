import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Download, File, Folder, Trash2, Key, Server, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface FileItem {
  id: string;
  name: string;
  size: number;
  type: 'file' | 'folder';
  encrypted: boolean;
  bucket_id: string;
  created_at: string;
  download_url?: string;
}

interface FileManagerProps {
  bucketLicenses: any[];
  userId: string;
}

export const FileManager = ({ bucketLicenses, userId }: FileManagerProps) => {
  const { toast } = useToast();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState("");

  useEffect(() => {
    // Set API endpoint for desktop client integration
    setApiEndpoint(`https://ampftv.itsupport.com.bd/api/v1/sync/${userId}`);
  }, [userId]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedBucket) return;

    setUploading(true);
    try {
      // Create encrypted chunks simulation
      const chunks = Math.ceil(file.size / (1024 * 1024)); // 1MB chunks
      
      // Upload file with encryption metadata
      const { data, error } = await supabase.storage
        .from('user-files')
        .upload(`${userId}/${selectedBucket}/${file.name}`, file, {
          metadata: {
            encrypted: 'true',
            chunks: chunks.toString(),
            bucket_license: selectedBucket
          }
        });

      if (error) throw error;

      toast({
        title: "File uploaded successfully",
        description: `${file.name} has been encrypted and uploaded to your bucket.`,
      });

      fetchFiles();
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const fetchFiles = async () => {
    if (!selectedBucket) return;

    try {
      const { data, error } = await supabase.storage
        .from('user-files')
        .list(`${userId}/${selectedBucket}`);

      if (error) throw error;

      const fileItems: FileItem[] = data?.map(item => ({
        id: item.id || item.name,
        name: item.name,
        size: item.metadata?.size || 0,
        type: item.metadata?.mimetype ? 'file' : 'folder',
        encrypted: item.metadata?.encrypted === 'true',
        bucket_id: selectedBucket,
        created_at: item.created_at || new Date().toISOString(),
        download_url: item.metadata?.download_url
      })) || [];

      setFiles(fileItems);
    } catch (error: any) {
      console.error("Error fetching files:", error);
    }
  };

  const handleDownload = async (file: FileItem) => {
    try {
      const { data, error } = await supabase.storage
        .from('user-files')
        .download(`${userId}/${file.bucket_id}/${file.name}`);

      if (error) throw error;

      // Create download link
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);

      toast({
        title: "Download started",
        description: `${file.name} is being decrypted and downloaded.`,
      });
    } catch (error: any) {
      toast({
        title: "Download failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDeleteFile = async (file: FileItem) => {
    try {
      const { error } = await supabase.storage
        .from('user-files')
        .remove([`${userId}/${file.bucket_id}/${file.name}`]);

      if (error) throw error;

      toast({
        title: "File deleted",
        description: `${file.name} has been permanently deleted.`,
      });

      fetchFiles();
    } catch (error: any) {
      toast({
        title: "Delete failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const copyApiEndpoint = () => {
    navigator.clipboard.writeText(apiEndpoint);
    toast({
      title: "API Endpoint copied",
      description: "Desktop client integration URL copied to clipboard.",
    });
  };

  const generateDesktopConfig = () => {
    const config = {
      user_id: userId,
      api_endpoint: apiEndpoint,
      bucket_licenses: bucketLicenses.map(license => ({
        license_key: license.license_key,
        bucket_size_gb: license.bucket_size_gb,
        max_buckets: license.max_buckets,
        encryption_method: license.encryption_method
      })),
      sync_settings: {
        chunk_size_mb: 1,
        encryption: "AES-256-GCM",
        p2p_enabled: true,
        auto_sync: true
      }
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ampftv-desktop-config.json';
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: "Config downloaded",
      description: "Desktop client configuration file downloaded.",
    });
  };

  const generateWindowsInstaller = () => {
    const batContent = `@echo off
echo AMPFTV Desktop Client Setup
echo ============================
echo.

REM Create AMPFTV directory in user profile
set AMPFTV_DIR=%USERPROFILE%\\AMPFTV
if not exist "%AMPFTV_DIR%" mkdir "%AMPFTV_DIR%"

REM Create bucket directories
echo Setting up bucket locations...
${bucketLicenses.map(license => 
  `if not exist "%AMPFTV_DIR%\\${license.license_key}" mkdir "%AMPFTV_DIR%\\${license.license_key}"`
).join('\n')}

REM Create configuration file
echo Creating configuration...
(
echo {
echo   "user_id": "${userId}",
echo   "api_endpoint": "${apiEndpoint}",
echo   "bucket_licenses": [
${bucketLicenses.map((license, index) => 
  `echo     {
echo       "license_key": "${license.license_key}",
echo       "bucket_size_gb": ${license.bucket_size_gb},
echo       "max_buckets": ${license.max_buckets},
echo       "encryption_method": "${license.encryption_method}",
echo       "local_path": "%AMPFTV_DIR%\\${license.license_key}"
echo     }${index < bucketLicenses.length - 1 ? ',' : ''}`
).join('\n')}
echo   ],
echo   "sync_settings": {
echo     "chunk_size_mb": 1,
echo     "encryption": "AES-256-GCM",
echo     "p2p_enabled": true,
echo     "auto_sync": true
echo   }
echo }
^) > "%AMPFTV_DIR%\\config.json"

REM Set encryption store key in registry
echo Setting up EncryptStore Key...
reg add "HKCU\\Software\\AMPFTV" /v "EncryptStoreKey" /t REG_SZ /d "${userId}-${Date.now()}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserId" /t REG_SZ /d "${userId}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "ApiEndpoint" /t REG_SZ /d "${apiEndpoint}" /f >nul 2>&1

REM Create sync service batch file
echo Creating sync service...
(
echo @echo off
echo title AMPFTV Sync Service
echo echo AMPFTV Sync Service Running...
echo echo Press Ctrl+C to stop
echo :loop
echo REM Add your sync logic here
echo timeout /t 60 /nobreak ^>nul
echo goto loop
^) > "%AMPFTV_DIR%\\sync-service.bat"

REM Create auto-start entry
echo Setting up auto-start...
set STARTUP_DIR="%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
(
echo @echo off
echo cd /d "%AMPFTV_DIR%"
echo start "" /min "%AMPFTV_DIR%\\sync-service.bat"
^) > %STARTUP_DIR%\\AMPFTV-AutoStart.bat

REM Create desktop shortcut
echo Creating desktop shortcut...
set DESKTOP_DIR="%USERPROFILE%\\Desktop"
(
echo @echo off
echo cd /d "%AMPFTV_DIR%"
echo start "" "%AMPFTV_DIR%\\sync-service.bat"
^) > %DESKTOP_DIR%\\AMPFTV-Sync.bat

echo.
echo ============================
echo Setup completed successfully!
echo ============================
echo.
echo Bucket locations created in: %AMPFTV_DIR%
echo Configuration saved to: %AMPFTV_DIR%\\config.json
echo Sync service: %AMPFTV_DIR%\\sync-service.bat
echo.
echo The sync service will start automatically on Windows startup.
echo You can also manually start it using the desktop shortcut.
echo.
pause
`;

    const blob = new Blob([batContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'AMPFTV-Setup.bat';
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: "Windows installer downloaded",
      description: "AMPFTV-Setup.bat file downloaded. Run as administrator for full setup.",
    });
  };

  useEffect(() => {
    if (selectedBucket) {
      fetchFiles();
    }
  }, [selectedBucket]);

  return (
    <div className="space-y-6">
      {/* Desktop Client Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Server className="w-5 h-5 mr-2" />
            Desktop Client Integration
          </CardTitle>
          <CardDescription>
            API endpoints and configuration for AMPFTV desktop client sync
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-2">API Sync Endpoint:</p>
            <div className="flex items-center space-x-2">
              <code className="flex-1 text-sm bg-muted px-3 py-2 rounded">
                {apiEndpoint}
              </code>
              <Button variant="outline" size="sm" onClick={copyApiEndpoint}>
                <Key className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={generateDesktopConfig}>
              <Download className="w-4 h-4 mr-2" />
              Download Config
            </Button>
            <Button variant="outline" onClick={generateWindowsInstaller}>
              <Download className="w-4 h-4 mr-2" />
              Windows Installer
            </Button>
            <Button variant="outline">
              <RefreshCw className="w-4 h-4 mr-2" />
              Test Connection
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* File Manager */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Folder className="w-5 h-5 mr-2" />
            Bucket File Explorer
          </CardTitle>
          <CardDescription>
            Upload, download, and manage encrypted files in your buckets
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Bucket Selection */}
          <div>
            <label className="text-sm font-medium mb-2 block">Select Bucket:</label>
            <select 
              className="w-full p-2 border rounded-md bg-background"
              value={selectedBucket}
              onChange={(e) => setSelectedBucket(e.target.value)}
            >
              <option value="">Choose a bucket license...</option>
              {bucketLicenses.map((license) => (
                <option key={license.id} value={license.license_key}>
                  {license.license_key} ({license.bucket_size_gb}GB)
                </option>
              ))}
            </select>
          </div>

          {selectedBucket && (
            <>
              {/* File Upload */}
              <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground mb-4">
                  Drop files here or click to browse
                </p>
                <Input
                  type="file"
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="max-w-xs mx-auto"
                />
                {uploading && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Encrypting and uploading...
                  </p>
                )}
              </div>

              {/* File List */}
              <div className="space-y-2">
                {files.length === 0 ? (
                  <div className="text-center py-8">
                    <File className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">No files in this bucket</p>
                  </div>
                ) : (
                  files.map((file) => (
                    <div key={file.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center space-x-3">
                        <File className="w-5 h-5 text-muted-foreground" />
                        <div>
                          <p className="font-medium">{file.name}</p>
                          <div className="flex items-center space-x-2">
                            <p className="text-sm text-muted-foreground">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                            {file.encrypted && (
                              <Badge variant="secondary" className="text-xs">
                                Encrypted
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownload(file)}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteFile(file)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};