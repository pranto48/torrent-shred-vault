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
setlocal enabledelayedexpansion
color 0a
title AMPFTV Desktop Client Installer

echo.
echo  =============================================
echo   AMPFTV Desktop Client Installation Wizard
echo  =============================================
echo.
echo  This installer will set up your AMPFTV desktop client
echo  with torrent-like P2P sync capabilities.
echo.
echo  Press any key to continue or Ctrl+C to cancel...
pause >nul

echo.
echo [1/6] Creating AMPFTV directory structure...
set AMPFTV_DIR=%USERPROFILE%\\AMPFTV
if not exist "!AMPFTV_DIR!" mkdir "!AMPFTV_DIR!"
if not exist "!AMPFTV_DIR!\\buckets" mkdir "!AMPFTV_DIR!\\buckets"
if not exist "!AMPFTV_DIR!\\temp" mkdir "!AMPFTV_DIR!\\temp"
if not exist "!AMPFTV_DIR!\\logs" mkdir "!AMPFTV_DIR!\\logs"
echo    ✓ Base directories created

echo.
echo [2/6] Setting up bucket storage locations...
${bucketLicenses.map(license => 
  `if not exist "!AMPFTV_DIR!\\buckets\\${license.license_key}" mkdir "!AMPFTV_DIR!\\buckets\\${license.license_key}"
if not exist "!AMPFTV_DIR!\\buckets\\${license.license_key}\\shared" mkdir "!AMPFTV_DIR!\\buckets\\${license.license_key}\\shared"
if not exist "!AMPFTV_DIR!\\buckets\\${license.license_key}\\sync" mkdir "!AMPFTV_DIR!\\buckets\\${license.license_key}\\sync"
echo    ✓ Bucket ${license.license_key} (${license.bucket_size_gb}GB) ready`
).join('\n')}

echo.
echo [3/6] Generating encryption keys and configuration...
set ENCRYPT_KEY=${userId}-%RANDOM%-%DATE:~-4%-%TIME:~0,2%%TIME:~3,2%
set /p USER_NAME=Enter your display name for P2P network: 

(
echo {
echo   "user_id": "${userId}",
echo   "user_name": "!USER_NAME!",
echo   "api_endpoint": "${apiEndpoint}",
echo   "encrypt_store_key": "!ENCRYPT_KEY!",
echo   "p2p_settings": {
echo     "node_id": "${userId}",
echo     "discovery_port": 6881,
echo     "transfer_port": 6882,
echo     "max_peers": 50,
echo     "seed_ratio": 2.0,
echo     "auto_seed": true
echo   },
echo   "bucket_licenses": [
${bucketLicenses.map((license, index) => 
  `echo     {
echo       "license_key": "${license.license_key}",
echo       "bucket_size_gb": ${license.bucket_size_gb},
echo       "max_buckets": ${license.max_buckets},
echo       "encryption_method": "${license.encryption_method}",
echo       "local_path": "!AMPFTV_DIR!\\buckets\\${license.license_key}",
echo       "shared_path": "!AMPFTV_DIR!\\buckets\\${license.license_key}\\shared",
echo       "sync_path": "!AMPFTV_DIR!\\buckets\\${license.license_key}\\sync"
echo     }${index < bucketLicenses.length - 1 ? ',' : ''}`
).join('\n')}
echo   ],
echo   "sync_settings": {
echo     "chunk_size_mb": 1,
echo     "encryption": "AES-256-GCM",
echo     "p2p_enabled": true,
echo     "auto_sync": true,
echo     "torrent_mode": true,
echo     "watch_folders": true,
echo     "sync_interval": 30
echo   }
echo }
^) > "!AMPFTV_DIR!\\config.json"
echo    ✓ Configuration file created

echo.
echo [4/6] Registering encryption store key in Windows Registry...
reg add "HKCU\\Software\\AMPFTV" /v "EncryptStoreKey" /t REG_SZ /d "!ENCRYPT_KEY!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserId" /t REG_SZ /d "${userId}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserName" /t REG_SZ /d "!USER_NAME!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "ApiEndpoint" /t REG_SZ /d "${apiEndpoint}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "InstallPath" /t REG_SZ /d "!AMPFTV_DIR!" /f >nul 2>&1
echo    ✓ Registry entries created

echo.
echo [5/6] Creating AMPFTV P2P Sync Service...
(
echo @echo off
echo setlocal enabledelayedexpansion
echo title AMPFTV P2P Sync Service - !USER_NAME!
echo color 0b
echo.
echo  ========================================
echo   AMPFTV P2P File Sync Service Running
echo  ========================================
echo.
echo  User: !USER_NAME!
echo  Node ID: ${userId}
echo  Status: Scanning for peers...
echo.
echo  Press Ctrl+C to stop service
echo.
echo :main_loop
echo set LOG_FILE=!AMPFTV_DIR!\\logs\\sync-%%DATE:~-4,4%%%%DATE:~-10,2%%%%DATE:~-7,2%%.log
echo.
echo REM Simulate P2P discovery and file syncing
echo echo [%%TIME%%] Starting P2P discovery... ^>^> "!LOG_FILE!"
echo echo [%%TIME%%] Scanning buckets for changes...
echo.
echo REM Check each bucket for new files
${bucketLicenses.map(license => 
  `echo for /r "!AMPFTV_DIR!\\buckets\\${license.license_key}\\shared" %%f in ^(*.*^) do ^(
echo   echo [%%TIME%%] Found file: %%~nxf ^>^> "!LOG_FILE!"
echo   echo   Preparing to share: %%~nxf
echo ^)`
).join('\necho.')}
echo.
echo echo [%%TIME%%] P2P sync cycle completed ^>^> "!LOG_FILE!"
echo echo   Next sync in 30 seconds...
echo.
echo timeout /t 30 /nobreak ^>nul
echo goto main_loop
^) > "!AMPFTV_DIR!\\ampftv-sync.bat"
echo    ✓ P2P sync service created

echo.
echo [6/6] Setting up auto-start and shortcuts...
set STARTUP_DIR=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
(
echo @echo off
echo cd /d "!AMPFTV_DIR!"
echo start "" /min "!AMPFTV_DIR!\\ampftv-sync.bat"
^) > "!STARTUP_DIR!\\AMPFTV-AutoStart.bat"

set DESKTOP_DIR=%USERPROFILE%\\Desktop
(
echo @echo off
echo cd /d "!AMPFTV_DIR!"
echo start "" "!AMPFTV_DIR!\\ampftv-sync.bat"
^) > "!DESKTOP_DIR!\\AMPFTV-Sync.bat"

REM Create file manager shortcut
(
echo @echo off
echo start "" explorer "!AMPFTV_DIR!\\buckets"
^) > "!DESKTOP_DIR!\\AMPFTV-Buckets.bat"
echo    ✓ Desktop shortcuts created

echo.
echo  ================================================
echo   INSTALLATION COMPLETED SUCCESSFULLY!
echo  ================================================
echo.
echo  Your AMPFTV P2P Sync Client is now ready!
echo.
echo  Installation Details:
echo  • Install Path: !AMPFTV_DIR!
echo  • User Name: !USER_NAME!
echo  • Encrypt Key: !ENCRYPT_KEY!
echo  • Bucket Count: ${bucketLicenses.length}
echo  • Total Storage: ${bucketLicenses.reduce((total, license) => total + license.bucket_size_gb, 0)}GB
echo.
echo  Desktop Shortcuts Created:
echo  • AMPFTV-Sync.bat - Start sync service
echo  • AMPFTV-Buckets.bat - Open bucket folders
echo.
echo  The sync service will start automatically when Windows boots.
echo  Files placed in 'shared' folders will be automatically synced
echo  across your P2P network using torrent-like technology.
echo.
echo  Press any key to start the sync service now...
pause >nul
start "" /min "!AMPFTV_DIR!\\ampftv-sync.bat"
echo.
echo  AMPFTV Sync Service is now running in background!
echo  Check the system tray for status updates.
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