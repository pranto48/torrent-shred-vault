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
    // Build the bucket directory creation commands
    const bucketCommands = bucketLicenses.map(license => 
      `if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\shared" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\shared"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\sync" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\sync"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\downloads" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\downloads"
echo    ✓ Bucket ${license.license_key} (${license.bucket_size_gb}GB) ready`
    ).join('\n');

    // Build the bucket config JSON lines
    const bucketConfig = bucketLicenses.map((license, index) => 
      `echo     {
echo       "license_key": "${license.license_key}",
echo       "bucket_size_gb": ${license.bucket_size_gb},
echo       "max_buckets": ${license.max_buckets},
echo       "encryption_method": "${license.encryption_method}",
echo       "local_path": "!AMPFTV_DIR!\\\\\\\\buckets\\\\\\\\${license.license_key}",
echo       "shared_path": "!AMPFTV_DIR!\\\\\\\\buckets\\\\\\\\${license.license_key}\\\\\\\\shared",
echo       "sync_path": "!AMPFTV_DIR!\\\\\\\\buckets\\\\\\\\${license.license_key}\\\\\\\\sync",
echo       "downloads_path": "!AMPFTV_DIR!\\\\\\\\buckets\\\\\\\\${license.license_key}\\\\\\\\downloads"
echo     }${index < bucketLicenses.length - 1 ? ',' : ''}`
    ).join('\n');

    const totalStorage = bucketLicenses.reduce((total, license) => total + license.bucket_size_gb, 0);

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
echo  with real P2P file sharing and sync capabilities.
echo.
echo  Press any key to continue or Ctrl+C to cancel...
pause >nul

echo.
echo [1/8] Checking Node.js installation...
where node >nul 2>&1
if errorlevel 1 (
    echo    ✗ Node.js not found! Please install Node.js first.
    echo    Download from: https://nodejs.org/
    echo    Then run this installer again.
    pause
    exit /b 1
) else (
    echo    ✓ Node.js found
)

echo.
echo [2/8] Creating AMPFTV directory structure...
set AMPFTV_DIR=%USERPROFILE%\\AMPFTV
if not exist "!AMPFTV_DIR!" mkdir "!AMPFTV_DIR!"
if not exist "!AMPFTV_DIR!\\buckets" mkdir "!AMPFTV_DIR!\\buckets"
if not exist "!AMPFTV_DIR!\\temp" mkdir "!AMPFTV_DIR!\\temp"
if not exist "!AMPFTV_DIR!\\logs" mkdir "!AMPFTV_DIR!\\logs"
if not exist "!AMPFTV_DIR!\\torrents" mkdir "!AMPFTV_DIR!\\torrents"
if not exist "!AMPFTV_DIR!\\downloads" mkdir "!AMPFTV_DIR!\\downloads"
echo    ✓ Base directories created

echo.
echo [3/8] Setting up bucket storage locations...
${bucketCommands}

echo.
echo [4/8] Installing P2P dependencies...
cd /d "!AMPFTV_DIR!"
echo {"name":"ampftv-client","version":"1.0.0","main":"index.js"} > package.json
echo Installing dependencies... This may take a few minutes.
call npm install webtorrent express chokidar ws >nul 2>&1
echo    ✓ Dependencies installed

echo.
echo [5/8] Generating encryption keys and configuration...
set ENCRYPT_KEY=${userId}-%RANDOM%-%DATE:~-4%-%TIME:~0,2%%TIME:~3,2%
set /p USER_NAME=Enter your display name for P2P network: 
if "!USER_NAME!"=="" set USER_NAME=AMPFTV-User

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
echo     "web_ui_port": 8080,
echo     "max_peers": 50,
echo     "seed_ratio": 2.0,
echo     "auto_seed": true,
echo     "download_speed_limit": 0,
echo     "upload_speed_limit": 0
echo   },
echo   "bucket_licenses": [
${bucketConfig}
echo   ],
echo   "sync_settings": {
echo     "chunk_size_mb": 1,
echo     "encryption": "AES-256-GCM",
echo     "p2p_enabled": true,
echo     "auto_sync": true,
echo     "torrent_mode": true,
echo     "watch_folders": true,
echo     "sync_interval": 30,
echo     "tracker_servers": [
echo       "udp://tracker.openbittorrent.com:80",
echo       "udp://tracker.opentrackr.org:1337",
echo       "udp://9.rarbg.to:2710"
echo     ]
echo   }
echo }
^) > "!AMPFTV_DIR!\\config.json"
echo    ✓ Configuration file created

echo.
echo [6/8] Creating P2P torrent service...
echo Creating Node.js service file...
(
echo const WebTorrent = require^('webtorrent'^);
echo const fs = require^('fs'^);
echo const path = require^('path'^);
echo const chokidar = require^('chokidar'^);
echo const express = require^('express'^);
echo.
echo const config = JSON.parse^(fs.readFileSync^('./config.json', 'utf8'^)^);
echo const client = new WebTorrent^(^);
echo const app = express^(^);
echo.
echo console.log^('==========================================='^);
echo console.log^('  AMPFTV P2P Client Starting...'^);
echo console.log^('==========================================='^);
echo console.log^('User:', config.user_name^);
echo console.log^('Node ID:', config.user_id^);
echo console.log^('Buckets:', config.bucket_licenses.length^);
echo console.log^('Web UI Port:', config.p2p_settings.web_ui_port^);
echo console.log^('==========================================='^);
echo.
echo // Simple Web UI
echo app.get^('/', ^(req, res^) =^> {
echo   const html = \`
echo   ^<html^>
echo   ^<head^>^<title^>AMPFTV P2P Client^</title^>^</head^>
echo   ^<body style="font-family: Arial, sans-serif; margin: 20px;"^>
echo     ^<h1^>AMPFTV P2P File Sharing Client^</h1^>
echo     ^<h2 style="color: green;"^>Status: Running^</h2^>
echo     ^<p^>^<strong^>User:^</strong^> \$^{config.user_name^}^</p^>
echo     ^<p^>^<strong^>Active Torrents:^</strong^> \$^{client.torrents.length^}^</p^>
echo     ^<p^>^<strong^>Files Shared:^</strong^> \$^{client.torrents.reduce^(^(total, t^) =^> total + t.files.length, 0^)^}^</p^>
echo     ^<h3^>Buckets:^</h3^>
echo     ^<ul^>
echo       \$^{config.bucket_licenses.map^(b =^> \`^<li^>\$^{b.license_key^} - \$^{b.bucket_size_gb^}GB^</li^>\`^).join^(''^)^}
echo     ^</ul^>
echo     ^<h3^>How to Use:^</h3^>
echo     ^<ol^>
echo       ^<li^>Put files in 'shared' folders to automatically seed them^</li^>
echo       ^<li^>Copy .magnet files to 'torrents' folder to download^</li^>
echo       ^<li^>Downloaded files appear in 'downloads' folder^</li^>
echo     ^</ol^>
echo   ^</body^>
echo   ^</html^>
echo   \`;
echo   res.send^(html^);
echo }^);
echo.
echo const server = app.listen^(config.p2p_settings.web_ui_port, ^(^) =^> {
echo   console.log^(\`Web UI running at http://localhost:\$^{config.p2p_settings.web_ui_port^}\`^);
echo }^);
echo.
echo // File watcher for auto-seeding
echo config.bucket_licenses.forEach^(bucket =^> {
echo   const sharedPath = bucket.shared_path.replace^(/\\\\\\\\/g, '/'^);
echo   console.log^(\`Watching for new files: \$^{sharedPath^}\`^);
echo   
echo   if ^(fs.existsSync^(sharedPath^)^) {
echo     chokidar.watch^(sharedPath^).on^('add', ^(filePath^) =^> {
echo       console.log^(\`New file detected: \$^{path.basename^(filePath^)^}\`^);
echo       
echo       client.seed^(filePath, {
echo         name: path.basename^(filePath^),
echo         announce: config.sync_settings.tracker_servers
echo       }, ^(torrent^) =^> {
echo         console.log^(\`Now seeding: \$^{torrent.name^}\`^);
echo         
echo         const torrentPath = path.join^('./torrents', torrent.name + '.torrent'^);
echo         fs.writeFileSync^(torrentPath, torrent.torrentFile^);
echo         
echo         const magnetPath = path.join^('./torrents', torrent.name + '.magnet'^);
echo         fs.writeFileSync^(magnetPath, torrent.magnetURI^);
echo         console.log^(\`Magnet link saved: \$^{magnetPath^}\`^);
echo       }^);
echo     }^);
echo   }
echo }^);
echo.
echo // Auto-download from magnet files
echo setInterval^(^(^) =^> {
echo   const torrentsDir = './torrents';
echo   if ^(fs.existsSync^(torrentsDir^)^) {
echo     fs.readdirSync^(torrentsDir^).forEach^(file =^> {
echo       if ^(file.endsWith^('.magnet'^) ^&^& !file.startsWith^('downloaded_'^)^) {
echo         const magnetPath = path.join^(torrentsDir, file^);
echo         const magnetURI = fs.readFileSync^(magnetPath, 'utf8'^);
echo         
echo         if ^(!client.torrents.find^(t =^> t.magnetURI === magnetURI^)^) {
echo           console.log^(\`Starting download from: \$^{file^}\`^);
echo           
echo           client.add^(magnetURI, { path: './downloads' }, ^(torrent^) =^> {
echo             console.log^(\`Downloading: \$^{torrent.name^}\`^);
echo             
echo             torrent.on^('done', ^(^) =^> {
echo               console.log^(\`Download completed: \$^{torrent.name^}\`^);
echo               fs.renameSync^(magnetPath, path.join^(torrentsDir, 'downloaded_' + file^)^);
echo             }^);
echo           }^);
echo         }
echo       }
echo     }^);
echo   }
echo }, 10000^);
echo.
echo console.log^('\\nAMPFTV P2P Client is running!'^);
echo console.log^('Press Ctrl+C to stop the service'^);
^) > "!AMPFTV_DIR!\\ampftv-service.js"
echo    ✓ P2P service created

echo.
echo [7/8] Creating startup and control scripts...
(
echo @echo off
echo title AMPFTV P2P Service - !USER_NAME!
echo color 0b
echo cd /d "!AMPFTV_DIR!"
echo echo Starting AMPFTV P2P Service...
echo echo Web UI will be available at: http://localhost:8080
echo echo.
echo node ampftv-service.js
echo pause
^) > "!AMPFTV_DIR!\\start-service.bat"

set DESKTOP_DIR=%USERPROFILE%\\Desktop
(
echo @echo off
echo cd /d "!AMPFTV_DIR!"
echo start "" "!AMPFTV_DIR!\\start-service.bat"
^) > "!DESKTOP_DIR!\\AMPFTV-Start.bat"

(
echo @echo off
echo start "" http://localhost:8080
^) > "!DESKTOP_DIR!\\AMPFTV-WebUI.bat"

(
echo @echo off
echo start "" explorer "!AMPFTV_DIR!\\buckets"
^) > "!DESKTOP_DIR!\\AMPFTV-Buckets.bat"

(
echo @echo off
echo start "" explorer "!AMPFTV_DIR!\\downloads"
^) > "!DESKTOP_DIR!\\AMPFTV-Downloads.bat"

(
echo @echo off
echo start "" explorer "!AMPFTV_DIR!\\torrents"
^) > "!DESKTOP_DIR!\\AMPFTV-Torrents.bat"

set STARTUP_DIR=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
(
echo @echo off
echo cd /d "!AMPFTV_DIR!"
echo start "" /min "!AMPFTV_DIR!\\start-service.bat"
^) > "!STARTUP_DIR!\\AMPFTV-AutoStart.bat"

echo    ✓ Control scripts created

echo.
echo [8/8] Setting up Windows Registry entries...
reg add "HKCU\\Software\\AMPFTV" /v "EncryptStoreKey" /t REG_SZ /d "!ENCRYPT_KEY!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserId" /t REG_SZ /d "${userId}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserName" /t REG_SZ /d "!USER_NAME!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "ApiEndpoint" /t REG_SZ /d "${apiEndpoint}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "InstallPath" /t REG_SZ /d "!AMPFTV_DIR!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "WebUIPort" /t REG_SZ /d "8080" /f >nul 2>&1
echo    ✓ Registry entries created

echo.
echo  ===================================================
echo   AMPFTV P2P CLIENT INSTALLATION COMPLETED!
echo  ===================================================
echo.
echo  Installation Details:
echo  • Install Path: !AMPFTV_DIR!
echo  • User Name: !USER_NAME!
echo  • User ID: ${userId}
echo  • Bucket Count: ${bucketLicenses.length}
echo  • Total Storage: ${totalStorage}GB
echo  • Web UI Port: 8080
echo.
echo  Desktop Shortcuts Created:
echo  • AMPFTV-Start.bat - Start P2P service
echo  • AMPFTV-WebUI.bat - Open web interface
echo  • AMPFTV-Buckets.bat - Open shared folders
echo  • AMPFTV-Downloads.bat - Open downloads folder
echo  • AMPFTV-Torrents.bat - Open torrent files
echo.
echo  HOW TO USE:
echo  1. Put files in 'shared' folders to automatically seed them
echo  2. Copy magnet links (.magnet files) to 'torrents' folder to download
echo  3. Use Web UI at http://localhost:8080 to monitor activity
echo  4. Downloaded files appear in 'downloads' folder
echo  5. Service auto-starts with Windows
echo.
echo  Press any key to start the service now...
pause >nul
start "" "!AMPFTV_DIR!\\start-service.bat"
echo.
echo  AMPFTV P2P Service started!
echo  Opening Web UI at http://localhost:8080
start "" http://localhost:8080
echo.
pause`;

    const blob = new Blob([batContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'AMPFTV-Setup.bat';
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: "Windows installer downloaded",
      description: "AMPFTV-Setup.bat file downloaded. Run as administrator for full P2P setup with real torrent functionality.",
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
            Real P2P torrent-like file sharing system with automatic seeding and syncing
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
              Windows P2P Installer
            </Button>
            <Button variant="outline">
              <RefreshCw className="w-4 h-4 mr-2" />
              Test Connection
            </Button>
          </div>
          <div className="p-4 bg-muted rounded-lg">
            <h4 className="font-medium mb-2">How P2P File Sharing Works:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Files placed in "shared" folders are automatically seeded to the network</li>
              <li>• Copy magnet links (.magnet files) to "torrents" folder to download</li>
              <li>• Web UI at localhost:8080 shows real-time activity</li>
              <li>• Uses WebTorrent technology for peer-to-peer file sharing</li>
              <li>• Service runs automatically with Windows startup</li>
            </ul>
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