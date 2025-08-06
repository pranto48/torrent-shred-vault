@echo off
echo ============================================
echo    BucketLynx P2P File Sync Client Setup
echo ============================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js found, continuing setup...
echo.

REM Prompt for bucket name
set /p BUCKET_NAME="Enter your bucket name (e.g., my-sync-bucket): "
if "%BUCKET_NAME%"=="" (
    echo ERROR: Bucket name cannot be empty!
    pause
    exit /b 1
)

REM Prompt for sync folder location
set /p SYNC_PATH="Enter sync folder path (e.g., C:\BucketLynx\%BUCKET_NAME%): "
if "%SYNC_PATH%"=="" (
    set SYNC_PATH=C:\BucketLynx\%BUCKET_NAME%
)

echo.
echo Setting up directories...
mkdir "%SYNC_PATH%" 2>nul
mkdir "%SYNC_PATH%\shared" 2>nul
mkdir "%SYNC_PATH%\torrents" 2>nul
mkdir "%SYNC_PATH%\downloads" 2>nul

REM Create package.json for the P2P client
echo Creating P2P client configuration...
(
echo {
echo   "name": "bucketlynx-p2p-client",
echo   "version": "1.0.0",
echo   "description": "BucketLynx P2P File Sync Client",
echo   "main": "sync-client.js",
echo   "dependencies": {
echo     "webtorrent": "^2.0.0",
echo     "express": "^4.18.0",
echo     "ws": "^8.14.0",
echo     "chokidar": "^3.5.0",
echo     "node-notifier": "^10.0.1"
echo   }
echo }
) > "%SYNC_PATH%\package.json"

REM Create the main sync client
(
echo const WebTorrent = require('webtorrent'^)
echo const express = require('express'^)
echo const WebSocket = require('ws'^)
echo const chokidar = require('chokidar'^)
echo const fs = require('fs'^)
echo const path = require('path'^)
echo const notifier = require('node-notifier'^)
echo.
echo const app = express(^)
echo const client = new WebTorrent(^)
echo const PORT = 8080
echo const BUCKET_NAME = '%BUCKET_NAME%'
echo const SYNC_PATH = '%SYNC_PATH%'
echo.
echo // Web UI routes
echo app.use(express.static(__dirname + '/public'^)^)
echo app.use(express.json(^)^)
echo.
echo app.get('/', (req, res^) =^> {
echo   res.send(`
echo   ^<!DOCTYPE html^>
echo   ^<html^>
echo   ^<head^>
echo     ^<title^>BucketLynx P2P Sync - ${BUCKET_NAME}^</title^>
echo     ^<style^>
echo       body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
echo       .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1^); }
echo       .header { text-align: center; margin-bottom: 30px; }
echo       .status { display: flex; gap: 20px; margin-bottom: 20px; }
echo       .stat-card { flex: 1; padding: 15px; background: #f8f9fa; border-radius: 6px; text-align: center; }
echo       .stat-value { font-size: 24px; font-weight: bold; color: #2563eb; }
echo       .stat-label { font-size: 14px; color: #6b7280; margin-top: 5px; }
echo       .files-section { margin-top: 20px; }
echo       .file-item { padding: 10px; border: 1px solid #e5e7eb; margin: 5px 0; border-radius: 4px; }
echo       .file-active { background: #dcfce7; border-color: #16a34a; }
echo       .log { height: 200px; overflow-y: auto; background: #1f2937; color: #f9fafb; padding: 10px; border-radius: 4px; font-family: monospace; }
echo     ^</style^>
echo   ^</head^>
echo   ^<body^>
echo     ^<div class="container"^>
echo       ^<div class="header"^>
echo         ^<h1^>🚀 BucketLynx P2P Sync^</h1^>
echo         ^<p^>Bucket: ^<strong^>${BUCKET_NAME}^</strong^> • Path: ^<strong^>${SYNC_PATH}^</strong^>^</p^>
echo       ^</div^>
echo       ^<div class="status"^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="torrentCount"^>0^</div^>
echo           ^<div class="stat-label"^>Active Torrents^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="peerCount"^>0^</div^>
echo           ^<div class="stat-label"^>Connected Peers^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="downloadSpeed"^>0^</div^>
echo           ^<div class="stat-label"^>Download Speed (KB/s^)^</div^>
echo         ^</div^>
echo         ^<div class="stat-card"^>
echo           ^<div class="stat-value" id="uploadSpeed"^>0^</div^>
echo           ^<div class="stat-label"^>Upload Speed (KB/s^)^</div^>
echo         ^</div^>
echo       ^</div^>
echo       ^<div class="files-section"^>
echo         ^<h3^>Active Files^</h3^>
echo         ^<div id="filesList"^>^</div^>
echo       ^</div^>
echo       ^<div class="files-section"^>
echo         ^<h3^>Activity Log^</h3^>
echo         ^<div id="activityLog" class="log"^>^</div^>
echo       ^</div^>
echo     ^</div^>
echo     ^<script^>
echo       const ws = new WebSocket('ws://localhost:8081'^);
echo       const log = document.getElementById('activityLog'^);
echo       
echo       ws.onmessage = (event^) =^> {
echo         const data = JSON.parse(event.data^);
echo         updateUI(data^);
echo         addLog(data.message || 'Status update'^);
echo       };
echo       
echo       function updateUI(data^) {
echo         document.getElementById('torrentCount'^).textContent = data.torrents || 0;
echo         document.getElementById('peerCount'^).textContent = data.peers || 0;
echo         document.getElementById('downloadSpeed'^).textContent = Math.round((data.downloadSpeed || 0^) / 1024^);
echo         document.getElementById('uploadSpeed'^).textContent = Math.round((data.uploadSpeed || 0^) / 1024^);
echo         
echo         const filesList = document.getElementById('filesList'^);
echo         if (data.files^) {
echo           filesList.innerHTML = data.files.map(f =^> 
echo             `^<div class="file-item ${f.active ? 'file-active' : ''}"^>${f.name} - ${f.progress}% - ${f.peers} peers^</div^>`
echo           ^).join(''^);
echo         }
echo       }
echo       
echo       function addLog(message^) {
echo         const timestamp = new Date(^).toLocaleTimeString(^);
echo         log.innerHTML += `${timestamp}: ${message}\n`;
echo         log.scrollTop = log.scrollHeight;
echo       }
echo       
echo       addLog('P2P client connected to web interface'^);
echo     ^</script^>
echo   ^</body^>
echo   ^</html^>
echo   `^);
echo }^);
echo.
echo // WebSocket server for real-time updates
echo const wss = new WebSocket.Server({ port: 8081 }^);
echo let connectedClients = [];
echo.
echo wss.on('connection', (ws^) =^> {
echo   connectedClients.push(ws^);
echo   console.log('Web UI client connected'^);
echo   
echo   ws.on('close', (^) =^> {
echo     connectedClients = connectedClients.filter(c =^> c !== ws^);
echo   }^);
echo }^);
echo.
echo function broadcastUpdate(data^) {
echo   connectedClients.forEach(client =^> {
echo     if (client.readyState === WebSocket.OPEN^) {
echo       client.send(JSON.stringify(data^)^);
echo     }
echo   }^);
echo }
echo.
echo // File watcher for shared folder
echo const sharedWatcher = chokidar.watch(path.join(SYNC_PATH, 'shared'^), {
echo   ignored: /^\./, persistent: true
echo }^);
echo.
echo sharedWatcher.on('add', (filePath^) =^> {
echo   console.log(`New file detected: ${filePath}`^);
echo   seedFile(filePath^);
echo }^);
echo.
echo // Magnet file watcher
echo const magnetWatcher = chokidar.watch(path.join(SYNC_PATH, 'torrents'^), {
echo   ignored: /^\./, persistent: true
echo }^);
echo.
echo magnetWatcher.on('add', (filePath^) =^> {
echo   if (path.extname(filePath^) === '.magnet'^) {
echo     console.log(`New magnet file: ${filePath}`^);
echo     processMagnetFile(filePath^);
echo   }
echo }^);
echo.
echo function seedFile(filePath^) {
echo   client.seed(filePath, (torrent^) =^> {
echo     console.log(`Seeding: ${torrent.name}`^);
echo     const magnetLink = torrent.magnetURI;
echo     
echo     // Save magnet link
echo     const magnetFile = path.join(SYNC_PATH, 'torrents', `${path.basename(filePath^)}.magnet`^);
echo     fs.writeFileSync(magnetFile, magnetLink^);
echo     
echo     notifier.notify({
echo       title: 'BucketLynx P2P',
echo       message: `Now seeding: ${torrent.name}`,
echo       timeout: 3000
echo     }^);
echo     
echo     broadcastUpdate({
echo       message: `Started seeding: ${torrent.name}`,
echo       torrents: client.torrents.length,
echo       files: getTorrentStats(^)
echo     }^);
echo   }^);
echo }
echo.
echo function processMagnetFile(magnetFilePath^) {
echo   const magnetLink = fs.readFileSync(magnetFilePath, 'utf8'^).trim(^);
echo   
echo   client.add(magnetLink, { path: path.join(SYNC_PATH, 'downloads'^) }, (torrent^) =^> {
echo     console.log(`Downloading: ${torrent.name}`^);
echo     
echo     notifier.notify({
echo       title: 'BucketLynx P2P',
echo       message: `Started download: ${torrent.name}`,
echo       timeout: 3000
echo     }^);
echo     
echo     torrent.on('done', (^) =^> {
echo       console.log(`Download completed: ${torrent.name}`^);
echo       notifier.notify({
echo         title: 'BucketLynx P2P',
echo         message: `Download completed: ${torrent.name}`,
echo         timeout: 5000
echo       }^);
echo     }^);
echo     
echo     broadcastUpdate({
echo       message: `Started download: ${torrent.name}`,
echo       torrents: client.torrents.length,
echo       files: getTorrentStats(^)
echo     }^);
echo   }^);
echo }
echo.
echo function getTorrentStats(^) {
echo   return client.torrents.map(t =^> ({
echo     name: t.name,
echo     progress: Math.round(t.progress * 100^),
echo     peers: t.numPeers,
echo     active: t.progress ^< 1
echo   }^)^);
echo }
echo.
echo // Periodic status updates
echo setInterval((^) =^> {
echo   const totalDownloadSpeed = client.torrents.reduce((acc, t^) =^> acc + t.downloadSpeed, 0^);
echo   const totalUploadSpeed = client.torrents.reduce((acc, t^) =^> acc + t.uploadSpeed, 0^);
echo   const totalPeers = client.torrents.reduce((acc, t^) =^> acc + t.numPeers, 0^);
echo   
echo   broadcastUpdate({
echo     torrents: client.torrents.length,
echo     peers: totalPeers,
echo     downloadSpeed: totalDownloadSpeed,
echo     uploadSpeed: totalUploadSpeed,
echo     files: getTorrentStats(^)
echo   }^);
echo }, 2000^);
echo.
echo // Start the server
echo app.listen(PORT, (^) =^> {
echo   console.log(`BucketLynx P2P Client running at http://localhost:${PORT}`^);
echo   console.log(`Bucket: ${BUCKET_NAME}`^);
echo   console.log(`Sync Path: ${SYNC_PATH}`^);
echo   console.log('Place files in "shared" folder to seed them'^);
echo   console.log('Place .magnet files in "torrents" folder to download'^);
echo   
echo   notifier.notify({
echo     title: 'BucketLynx P2P Client',
echo     message: `Started for bucket: ${BUCKET_NAME}`,
echo     timeout: 5000
echo   }^);
echo }^);
) > "%SYNC_PATH%\sync-client.js"

echo.
echo Installing dependencies...
cd /d "%SYNC_PATH%"
call npm install

echo.
echo Creating startup batch file...
(
echo @echo off
echo cd /d "%SYNC_PATH%"
echo echo Starting BucketLynx P2P Client for %BUCKET_NAME%...
echo node sync-client.js
echo pause
) > "%SYNC_PATH%\start-client.bat"

REM Create desktop shortcut
echo Creating desktop shortcut...
set DESKTOP=%USERPROFILE%\Desktop
(
echo @echo off
echo echo Starting BucketLynx P2P Client for %BUCKET_NAME%...
echo echo Sync Path: %SYNC_PATH%
echo cd /d "%SYNC_PATH%"
echo if not exist "sync-client.js" (
echo   echo ERROR: sync-client.js not found in %SYNC_PATH%
echo   echo Please run the setup script again.
echo   pause
echo   exit /b 1
echo )
echo node sync-client.js
echo pause
) > "%DESKTOP%\BucketLynx P2P - %BUCKET_NAME%.bat"

echo.
echo ============================================
echo           SETUP COMPLETE!
echo ============================================
echo.
echo Bucket Name: %BUCKET_NAME%
echo Sync Path: %SYNC_PATH%
echo Web UI: http://localhost:8080
echo.
echo USAGE:
echo 1. Run the desktop shortcut to start the P2P client
echo 2. Put files in the "shared" folder to share them
echo 3. Put .magnet files in "torrents" folder to download
echo 4. Monitor activity at http://localhost:8080
echo.
echo A desktop shortcut has been created for easy access.
echo.
pause

REM Auto-start the client
echo Starting P2P client now...
echo.
echo You can also manually start the client by:
echo 1. Running the desktop shortcut "BucketLynx P2P - %BUCKET_NAME%"
echo 2. Or running "start-client.bat" in %SYNC_PATH%
echo.
echo Press any key to start the P2P client now...
pause >nul
cd /d "%SYNC_PATH%"
start "BucketLynx P2P - %BUCKET_NAME%" cmd /k "echo Starting BucketLynx P2P Client for %BUCKET_NAME%... && node sync-client.js"