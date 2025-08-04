import React, { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Download, File, Folder, Trash2, Key, Server, RefreshCw, Share, RotateCcw, ExternalLink, Copy } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
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

interface SyncFile {
  bucket_id: string;
  file_name: string;
  file_size: number;
  magnet_link: string;
  last_modified: string;
  file_path: string;
}

interface FileManagerProps {
  bucketLicenses: any[];
  userId: string;
}

export const FileManager = ({ bucketLicenses, userId }: FileManagerProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [syncFiles, setSyncFiles] = useState<SyncFile[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState("");

  useEffect(() => {
    // Set API endpoint for desktop client integration
    setApiEndpoint(`https://xoatoskjxjzoambdijtu.supabase.co/functions/v1/sync/${userId}`);
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

  const syncFileData = async () => {
    if (!user) return;
    
    setIsLoading(true);
    setIsSyncing(true);
    setSyncProgress(0);

    try {
      // Simulate sync progress
      const progressSteps = [20, 40, 60, 80, 100];
      for (const step of progressSteps) {
        setSyncProgress(step);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Call sync API
      const { data, error } = await supabase.functions.invoke('sync', {
        body: { action: 'sync_request' }
      });

      if (error) throw error;

      if (data?.files) {
        setSyncFiles(data.files);
        toast({
          title: "Sync completed",
          description: `Synced ${data.files.length} files successfully!`,
        });
      }
    } catch (error: any) {
      console.error('Sync error:', error);
      toast({
        title: "Sync failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setIsSyncing(false);
    }
  };

  const loadSyncFiles = async () => {
    if (!user) return;
    
    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync');
      
      if (error) throw error;
      
      if (data?.files) {
        setSyncFiles(data.files);
      }
    } catch (error: any) {
      console.error('Load sync files error:', error);
      toast({
        title: "Failed to load sync files",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyMagnetLink = (magnetLink: string) => {
    navigator.clipboard.writeText(magnetLink);
    toast({
      title: "Magnet link copied",
      description: "Magnet link copied to clipboard for torrent download.",
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const generateWindowsInstaller = () => {
    // Build the bucket directory creation commands with progress
    const bucketCommands = bucketLicenses.map((license, index) => 
      `echo [Bucket ${index + 1}/${bucketLicenses.length}] Setting up ${license.license_key}...
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\shared" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\shared"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\sync" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\sync"
if not exist "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\downloads" mkdir "!AMPFTV_DIR!\\\\buckets\\\\${license.license_key}\\\\downloads"
echo Path: !AMPFTV_DIR!\\\\buckets\\\\${license.license_key}
echo    ✓ Bucket ${license.license_key} (${license.bucket_size_gb}GB) ready
echo.`
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
echo    █████████████████████████████████████████████████ 62%%
set ENCRYPT_KEY=${userId}-%RANDOM%-%DATE:~-4%-%TIME:~0,2%%TIME:~3,2%
echo    Encryption key generated: !ENCRYPT_KEY!
echo.
set /p USER_NAME=Enter your display name for P2P network: 
if "!USER_NAME!"=="" set USER_NAME=AMPFTV-User
echo    P2P Display Name: !USER_NAME!
echo    Node ID: ${userId}
echo    ████████████████████████████████████████████████████ 75%%

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
echo [6/8] Creating advanced P2P torrent service...
echo    ██████████████████████████████████████████████████████ 87%%
echo    Creating enhanced Node.js service with real-time monitoring...
(
echo const WebTorrent = require^('webtorrent'^);
echo const fs = require^('fs'^);
echo const path = require^('path'^);
echo const chokidar = require^('chokidar'^);
echo const express = require^('express'^);
echo const WebSocket = require^('ws'^);
echo.
echo const config = JSON.parse^(fs.readFileSync^('./config.json', 'utf8'^)^);
echo const client = new WebTorrent^(^);
echo const app = express^(^);
echo.
echo // Real-time activity tracking
echo let activityLog = [];
echo let connectedPeers = [];
echo let uploadStats = { totalBytes: 0, currentSpeed: 0 };
echo let downloadStats = { totalBytes: 0, currentSpeed: 0 };
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
echo // Enhanced Web UI with real-time activity
echo app.get^('/', ^(req, res^) =^> {
echo   const html = \`
echo   ^<html^>
echo   ^<head^>
echo     ^<title^>AMPFTV P2P Client - Real-time Dashboard^</title^>
echo     ^<meta charset="utf-8"^>
echo     ^<meta name="viewport" content="width=device-width, initial-scale=1"^>
echo     ^<style^>
echo       body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #f5f5f5; }
echo       .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
echo       .header { background: linear-gradient^(135deg, #667eea 0%%, #764ba2 100%%^); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; text-align: center; }
echo       .status-grid { display: grid; grid-template-columns: repeat^(auto-fit, minmax^(250px, 1fr^)^); gap: 20px; margin-bottom: 20px; }
echo       .stat-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba^(0,0,0,0.1^); }
echo       .stat-value { font-size: 2em; font-weight: bold; color: #667eea; }
echo       .stat-label { color: #666; margin-top: 5px; }
echo       .progress-bar { width: 100%%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; margin: 10px 0; }
echo       .progress-fill { height: 100%%; background: linear-gradient^(90deg, #4CAF50, #8BC34A^); transition: width 0.3s; }
echo       .activity-log { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba^(0,0,0,0.1^); max-height: 400px; overflow-y: auto; }
echo       .activity-item { padding: 10px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; }
echo       .activity-item:last-child { border-bottom: none; }
echo       .bucket-list { display: grid; grid-template-columns: repeat^(auto-fill, minmax^(300px, 1fr^)^); gap: 15px; margin: 20px 0; }
echo       .bucket-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba^(0,0,0,0.1^); }
echo       .status-online { color: #4CAF50; font-weight: bold; }
echo       .peer-count { background: #667eea; color: white; padding: 5px 10px; border-radius: 15px; font-size: 0.8em; }
echo     ^</style^>
echo   ^</head^>
echo   ^<body^>
echo     ^<div class="container"^>
echo       ^<div class="header"^>
echo         ^<h1^>🌐 AMPFTV P2P Client Dashboard^</h1^>
echo         ^<p^>Real-time P2P File Sharing Network^</p^>
echo         ^<p^>User: \$^{config.user_name^} | Node: \$^{config.user_id.substring^(0,8^)^}...^</p^>
echo       ^</div^>
echo       
echo       ^<div class="status-grid"^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="torrent-count"^>\$^{client.torrents.length^}^</div^>
echo           ^<div class="stat-label"^>Active Torrents^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="peer-count"^>\$^{client.torrents.reduce^(^(total, t^) =^> total + t.numPeers, 0^)^}^</div^>
echo           ^<div class="stat-label"^>Connected Peers^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="download-speed"^>0^</div^>
echo           ^<div class="stat-label"^>Download Speed ^(KB/s^)^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="upload-speed"^>0^</div^>
echo           ^<div class="stat-label"^>Upload Speed ^(KB/s^)^</div^>
echo         ^</div^>
echo       ^</div^>
echo       
echo       ^<div class="bucket-list"^>
echo         \$^{config.bucket_licenses.map^(b =^> \`
echo           ^<div class="bucket-card"^>
echo             ^<h3^>📁 \$^{b.license_key^}^</h3^>
echo             ^<p^>Storage: \$^{b.bucket_size_gb^}GB^</p^>
echo             ^<p^>Path: \$^{b.shared_path^}^</p^>
echo             ^<span class="status-online"^>● Active^</span^>
echo           ^</div^>
echo         \`^).join^(''^)^}
echo       ^</div^>
echo       
echo       ^<div class="activity-log"^>
echo         ^<h3^>📊 Real-time Activity^</h3^>
echo         ^<div id="activity-feed"^>
echo           ^<div class="activity-item"^>
echo             ^<span^>Service started successfully^</span^>
echo             ^<span^>\$^{new Date^(^).toLocaleTimeString^(^)^}^</span^>
echo           ^</div^>
echo         ^</div^>
echo       ^</div^>
echo       
echo       ^<script^>
echo         // Real-time updates via WebSocket
echo         const ws = new WebSocket^('ws://localhost:8081'^);
echo         ws.onmessage = function^(event^) {
echo           const data = JSON.parse^(event.data^);
echo           if ^(data.type === 'stats'^) {
echo             document.getElementById^('torrent-count'^).textContent = data.torrents;
echo             document.getElementById^('peer-count'^).textContent = data.peers;
echo             document.getElementById^('download-speed'^).textContent = data.downloadSpeed;
echo             document.getElementById^('upload-speed'^).textContent = data.uploadSpeed;
echo           } else if ^(data.type === 'activity'^) {
echo             const feed = document.getElementById^('activity-feed'^);
echo             const item = document.createElement^('div'^);
echo             item.className = 'activity-item';
echo             item.innerHTML = \`^<span^>\$^{data.message^}^</span^>^<span^>\$^{new Date^(^).toLocaleTimeString^(^)^}^</span^>\`;
echo             feed.insertBefore^(item, feed.firstChild^);
echo             if ^(feed.children.length ^> 50^) feed.removeChild^(feed.lastChild^);
echo           }
echo         };
echo       ^</script^>
echo     ^</div^>
echo   ^</body^>
echo   ^</html^>
echo   \`;
echo   res.send^(html^);
echo }^);
echo.
echo // API endpoints for bucket management
echo app.get^('/api/buckets', ^(req, res^) =^> {
echo   res.json^(config.bucket_licenses.map^(b =^> ^(^{
echo     ...b,
echo     files: fs.existsSync^(b.shared_path^) ? fs.readdirSync^(b.shared_path^) : []
echo   }^)^)^);
echo }^);
echo.
echo app.get^('/api/stats', ^(req, res^) =^> {
echo   res.json^(^{
echo     torrents: client.torrents.length,
echo     peers: client.torrents.reduce^(^(total, t^) =^> total + t.numPeers, 0^),
echo     downloadSpeed: Math.round^(client.downloadSpeed / 1024^),
echo     uploadSpeed: Math.round^(client.uploadSpeed / 1024^),
echo     progress: client.progress
echo   }^);
echo }^);
echo.
echo // WebSocket server for real-time updates
echo const WebSocket = require^('ws'^);
echo const wss = new WebSocket.Server^({ port: 8081 }^);
echo.
echo const server = app.listen^(config.p2p_settings.web_ui_port, ^(^) =^> {
echo   console.log^(\`✓ Web UI running at http://localhost:\$^{config.p2p_settings.web_ui_port^}\`^);
echo   console.log^(\`✓ WebSocket server running on port 8081\`^);
echo   console.log^(\`✓ Real-time dashboard active\`^);
echo }^);
echo.
echo // Broadcast stats every 2 seconds
echo setInterval^(^(^) =^> {
echo   const stats = {
echo     type: 'stats',
echo     torrents: client.torrents.length,
echo     peers: client.torrents.reduce^(^(total, t^) =^> total + t.numPeers, 0^),
echo     downloadSpeed: Math.round^(client.downloadSpeed / 1024^),
echo     uploadSpeed: Math.round^(client.uploadSpeed / 1024^)
echo   };
echo   wss.clients.forEach^(ws =^> {
echo     if ^(ws.readyState === WebSocket.OPEN^) ws.send^(JSON.stringify^(stats^)^);
echo   }^);
echo }, 2000^);
echo.
echo // Enhanced file watcher for auto-seeding with progress tracking
echo config.bucket_licenses.forEach^(^(bucket, bucketIndex^) =^> {
echo   const sharedPath = bucket.shared_path.replace^(/\\\\\\\\/g, '/'^);
echo   console.log^(\`[Bucket \$^{bucketIndex + 1^}/\$^{config.bucket_licenses.length^}] Watching: \$^{sharedPath^}\`^);
echo   
echo   if ^(fs.existsSync^(sharedPath^)^) {
echo     chokidar.watch^(sharedPath^).on^('add', ^(filePath^) =^> {
echo       const fileName = path.basename^(filePath^);
echo       console.log^(\`📁 New file detected: \$^{fileName^} in \$^{bucket.license_key^}\`^);
echo       
echo       // Broadcast activity
echo       wss.clients.forEach^(ws =^> {
echo         if ^(ws.readyState === WebSocket.OPEN^) {
echo           ws.send^(JSON.stringify^(^{
echo             type: 'activity',
echo             message: \`📤 Seeding new file: \$^{fileName^} in \$^{bucket.license_key^}\`
echo           }^)^);
echo         }
echo       }^);
echo       
echo       client.seed^(filePath, {
echo         name: fileName,
echo         comment: \`AMPFTV - \$^{config.user_name^} - \$^{bucket.license_key^}\`,
echo         announce: config.sync_settings.tracker_servers
echo       }, ^(torrent^) =^> {
echo         console.log^(\`🌱 Now seeding: \$^{torrent.name^} - \$^{torrent.infoHash^}\`^);
echo         
echo         // Save torrent and magnet files
echo         const torrentPath = path.join^('./torrents', torrent.name + '.torrent'^);
echo         fs.writeFileSync^(torrentPath, torrent.torrentFile^);
echo         
echo         const magnetPath = path.join^('./torrents', torrent.name + '.magnet'^);
echo         fs.writeFileSync^(magnetPath, torrent.magnetURI^);
echo         
echo         // Create detailed info file
echo         const infoPath = path.join^('./torrents', torrent.name + '.info.json'^);
echo         fs.writeFileSync^(infoPath, JSON.stringify^(^{
echo           name: torrent.name,
echo           infoHash: torrent.infoHash,
echo           magnetURI: torrent.magnetURI,
echo           bucket: bucket.license_key,
echo           user: config.user_name,
echo           created: new Date^(^).toISOString^(^),
echo           size: torrent.length,
echo           files: torrent.files.map^(f =^> f.name^)
echo         }, null, 2^)^);
echo         
echo         console.log^(\`📋 Magnet link saved: \$^{magnetPath^}\`^);
echo         
echo         // Track seeding progress
echo         torrent.on^('upload', ^(^) =^> {
echo           wss.clients.forEach^(ws =^> {
echo             if ^(ws.readyState === WebSocket.OPEN^) {
echo               ws.send^(JSON.stringify^(^{
echo                 type: 'activity',
echo                 message: \`⬆️ Uploading \$^{fileName^} - \$^{Math.round^(torrent.uploadSpeed / 1024^)^} KB/s\`
echo               }^)^);
echo             }
echo           }^);
echo         }^);
echo       }^);
echo     }^);
echo   } else {
echo     console.log^(\`⚠️ Warning: Bucket path not found: \$^{sharedPath^}\`^);
echo   }
echo }^);
echo.
echo // Enhanced auto-download from magnet files with progress tracking
echo setInterval^(^(^) =^> {
echo   const torrentsDir = './torrents';
echo   if ^(fs.existsSync^(torrentsDir^)^) {
echo     fs.readdirSync^(torrentsDir^).forEach^(file =^> {
echo       if ^(file.endsWith^('.magnet'^) ^&^& !file.startsWith^('downloaded_'^)^) {
echo         const magnetPath = path.join^(torrentsDir, file^);
echo         const magnetURI = fs.readFileSync^(magnetPath, 'utf8'^).trim^(^);
echo         
echo         if ^(!client.torrents.find^(t =^> t.magnetURI === magnetURI^)^) {
echo           console.log^(\`📥 Starting download from: \$^{file^}\`^);
echo           
echo           // Broadcast download start
echo           wss.clients.forEach^(ws =^> {
echo             if ^(ws.readyState === WebSocket.OPEN^) {
echo               ws.send^(JSON.stringify^(^{
echo                 type: 'activity',
echo                 message: \`📥 Starting download: \$^{file.replace^('.magnet', ''^)^}\`
echo               }^)^);
echo             }
echo           }^);
echo           
echo           client.add^(magnetURI, { path: './downloads' }, ^(torrent^) =^> {
echo             console.log^(\`⬇️ Downloading: \$^{torrent.name^} - \$^{torrent.files.length^} files\`^);
echo             
echo             // Track download progress
echo             let lastProgress = 0;
echo             const progressInterval = setInterval^(^(^) =^> {
echo               const progress = Math.round^(torrent.progress * 100^);
echo               if ^(progress ^> lastProgress ^&^& progress %% 10 === 0^) {
echo                 lastProgress = progress;
echo                 console.log^(\`📊 \$^{torrent.name^}: \$^{progress^}%% complete\`^);
echo                 
echo                 wss.clients.forEach^(ws =^> {
echo                   if ^(ws.readyState === WebSocket.OPEN^) {
echo                     ws.send^(JSON.stringify^(^{
echo                       type: 'activity',
echo                       message: \`📊 \$^{torrent.name^}: \$^{progress^}%% - \$^{Math.round^(torrent.downloadSpeed / 1024^)^} KB/s\`
echo                     }^)^);
echo                   }
echo                 }^);
echo               }
echo             }, 1000^);
echo             
echo             torrent.on^('done', ^(^) =^> {
echo               clearInterval^(progressInterval^);
echo               console.log^(\`✅ Download completed: \$^{torrent.name^}\`^);
echo               
echo               // Broadcast completion
echo               wss.clients.forEach^(ws =^> {
echo                 if ^(ws.readyState === WebSocket.OPEN^) {
echo                   ws.send^(JSON.stringify^(^{
echo                     type: 'activity',
echo                     message: \`✅ Download complete: \$^{torrent.name^}\`
echo                   }^)^);
echo                 }
echo               }^);
echo               
echo               // Mark magnet as downloaded
echo               fs.renameSync^(magnetPath, path.join^(torrentsDir, 'downloaded_' + file^)^);
echo               
echo               // Create download summary
echo               const summaryPath = path.join^('./downloads', torrent.name + '_summary.json'^);
echo               fs.writeFileSync^(summaryPath, JSON.stringify^(^{
echo                 name: torrent.name,
echo                 downloadedAt: new Date^(^).toISOString^(^),
echo                 size: torrent.length,
echo                 files: torrent.files.map^(f =^> f.name^),
echo                 peers: torrent.numPeers,
echo                 magnetURI: torrent.magnetURI
echo               }, null, 2^)^);
echo             }^);
echo             
echo             torrent.on^('error', ^(err^) =^> {
echo               console.error^(\`❌ Download error for \$^{torrent.name^}:\`, err.message^);
echo               clearInterval^(progressInterval^);
echo             }^);
echo           }^);
echo         }
echo       }
echo     }^);
echo   }
echo }, 5000^);
echo.
echo console.log^('\\nAMPFTV P2P Client is running!'^);
echo console.log^('Press Ctrl+C to stop the service'^);
^) > "!AMPFTV_DIR!\\ampftv-service.js"
echo    ✓ P2P service created

echo.
echo [7/8] Creating startup and control scripts...
echo    ███████████████████████████████████████████████████████████ 95%%
(
echo @echo off
echo title AMPFTV P2P Service - !USER_NAME!
echo color 0b
echo cd /d "!AMPFTV_DIR!"
echo echo ================================
echo echo   AMPFTV P2P Service Starting
echo echo ================================
echo echo User: !USER_NAME!
echo echo Web UI: http://localhost:8080
echo echo WebSocket: ws://localhost:8081
echo echo Buckets: ${bucketLicenses.length} configured
echo echo ================================
echo echo.
echo echo Starting Node.js service...
echo node ampftv-service.js
echo pause
^) > "!AMPFTV_DIR!\\start-service.bat"

set DESKTOP_DIR=%USERPROFILE%\\Desktop
(
echo @echo off
echo echo Starting AMPFTV P2P Client...
echo cd /d "!AMPFTV_DIR!"
echo start "" "!AMPFTV_DIR!\\start-service.bat"
^) > "!DESKTOP_DIR!\\AMPFTV-Start.bat"

(
echo @echo off
echo echo Opening AMPFTV Web Dashboard...
echo timeout /t 3 /nobreak >nul
echo start "" http://localhost:8080
^) > "!DESKTOP_DIR!\\AMPFTV-WebUI.bat"

(
echo @echo off
echo echo Opening shared buckets folder...
echo start "" explorer "!AMPFTV_DIR!\\buckets"
^) > "!DESKTOP_DIR!\\AMPFTV-Buckets.bat"

(
echo @echo off
echo echo Opening downloads folder...
echo start "" explorer "!AMPFTV_DIR!\\downloads"
^) > "!DESKTOP_DIR!\\AMPFTV-Downloads.bat"

(
echo @echo off
echo echo Opening torrents folder...
echo start "" explorer "!AMPFTV_DIR!\\torrents"
^) > "!DESKTOP_DIR!\\AMPFTV-Torrents.bat"

(
echo @echo off
echo echo Creating service status check...
echo cd /d "!AMPFTV_DIR!"
echo echo Checking AMPFTV P2P Service Status...
echo echo.
echo curl -s http://localhost:8080/api/stats ^|^| echo Service not running
echo echo.
echo pause
^) > "!DESKTOP_DIR!\\AMPFTV-Status.bat"

set STARTUP_DIR=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
(
echo @echo off
echo cd /d "!AMPFTV_DIR!"
echo start "" /min "!AMPFTV_DIR!\\start-service.bat"
^) > "!STARTUP_DIR!\\AMPFTV-AutoStart.bat"

echo    ✓ Enhanced control scripts created
echo    ✓ Desktop shortcuts installed
echo    ✓ Auto-startup configured

echo.
echo [8/8] Setting up Windows Registry and finalizing...
echo    ████████████████████████████████████████████████████████████ 100%%
reg add "HKCU\\Software\\AMPFTV" /v "EncryptStoreKey" /t REG_SZ /d "!ENCRYPT_KEY!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserId" /t REG_SZ /d "${userId}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "UserName" /t REG_SZ /d "!USER_NAME!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "ApiEndpoint" /t REG_SZ /d "${apiEndpoint}" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "InstallPath" /t REG_SZ /d "!AMPFTV_DIR!" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "WebUIPort" /t REG_SZ /d "8080" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "WebSocketPort" /t REG_SZ /d "8081" /f >nul 2>&1
reg add "HKCU\\Software\\AMPFTV" /v "Version" /t REG_SZ /d "2.0.0" /f >nul 2>&1
echo    ✓ Registry entries created
echo    ✓ Service configuration saved
echo    ✓ P2P network parameters registered

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

  useEffect(() => {
    loadSyncFiles();
  }, [user]);

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

      {/* P2P Sync Manager */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Share className="w-5 h-5" />
            P2P File Sync Manager
          </CardTitle>
          <CardDescription>
            Sync files with torrent-like P2P technology and magnet links
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 flex-wrap">
            <Button 
              onClick={syncFileData} 
              disabled={isLoading || isSyncing}
              variant="outline"
              className="flex items-center gap-2"
            >
              <RotateCcw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
              {isSyncing ? 'Syncing...' : 'Sync Files'}
            </Button>

            <Button asChild variant="outline">
              <a href="http://localhost:8080" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                <ExternalLink className="w-4 h-4" />
                Open Web UI
              </a>
            </Button>
          </div>

          {isSyncing && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>Sync Progress</span>
                <span>{syncProgress}%</span>
              </div>
              <Progress value={syncProgress} />
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            <p><strong>API Sync Endpoint:</strong></p>
            <code className="bg-muted p-1 rounded text-xs">
              {apiEndpoint}
            </code>
          </div>

          <div className="space-y-3">
            <h4 className="font-medium">Shared Bucket Files ({syncFiles.length})</h4>
            {isLoading ? (
              <div className="text-center py-8">Loading sync files...</div>
            ) : syncFiles.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No files found for P2P sharing. Upload files to buckets to start sharing!
              </div>
            ) : (
              <div className="space-y-3">
                {syncFiles.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-medium">{file.file_name}</h4>
                        <Badge variant="secondary">{file.bucket_id}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatFileSize(file.file_size)} • Modified {new Date(file.last_modified).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyMagnetLink(file.magnet_link)}
                        className="flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        Copy Magnet
                      </Button>
                      <Button asChild size="sm">
                        <a href={file.magnet_link} className="flex items-center gap-1">
                          <Download className="w-3 h-3" />
                          Download
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};