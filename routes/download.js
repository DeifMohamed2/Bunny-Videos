const express = require('express');
const router = express.Router();
const DownloadService = require('../services/downloadService');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

// Get default download path
router.get('/default-path', (req, res) => {
    const defaultPath = path.join(os.homedir(), 'Downloads');
    res.json({ success: true, path: defaultPath });
});

// Set download path
router.post('/set-path', (req, res) => {
    try {
        const { downloadPath } = req.body;
        const queueManager = req.app.get('queueManager');
        
        if (!downloadPath) {
            return res.status(400).json({ success: false, error: 'No path provided' });
        }

        // Check if path exists
        if (!fs.existsSync(downloadPath)) {
            return res.status(400).json({ success: false, error: 'Path does not exist' });
        }

        // Check if path is writable
        try {
            fs.accessSync(downloadPath, fs.constants.W_OK);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Path is not writable' });
        }

        queueManager.setDownloadDir(downloadPath);
        res.json({ success: true, path: downloadPath });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get current download path
router.get('/current-path', (req, res) => {
    const queueManager = req.app.get('queueManager');
    res.json({ success: true, path: queueManager.getDownloadDir() });
});

// Open folder picker dialog (macOS/Windows/Linux support)
router.get('/browse-folder', async (req, res) => {
    try {
        const platform = process.platform;
        let command;
        
        if (platform === 'darwin') {
            // macOS - use osascript
            command = `osascript -e 'POSIX path of (choose folder with prompt "Select Download Location")'`;
        } else if (platform === 'win32') {
            // Windows - use PowerShell
            command = `powershell -command "Add-Type -AssemblyName System.Windows.Forms; $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog; $folderBrowser.Description = 'Select Download Location'; $folderBrowser.ShowDialog() | Out-Null; $folderBrowser.SelectedPath"`;
        } else {
            // Linux - use zenity
            command = `zenity --file-selection --directory --title="Select Download Location" 2>/dev/null`;
        }

        exec(command, (error, stdout, stderr) => {
            if (error) {
                // User cancelled or error
                return res.json({ success: false, cancelled: true });
            }
            
            const selectedPath = stdout.trim();
            if (selectedPath && fs.existsSync(selectedPath)) {
                res.json({ success: true, path: selectedPath });
            } else {
                res.json({ success: false, cancelled: true });
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add video(s) to download queue
router.post('/add', async (req, res) => {
    try {
        const { urls, apiKey, libraryId } = req.body;
        
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please provide at least one video URL' 
            });
        }

        const queueManager = req.app.get('queueManager');
        const downloadService = new DownloadService(apiKey, libraryId);
        
        const addedJobs = [];
        
        for (const urlEntry of urls) {
            if (!urlEntry.trim()) continue;
            
            const url = urlEntry.trim();
            let videoTitle = null;
            
            // Extract video ID and try to fetch title from Bunny API
            const baseInfo = downloadService.extractBaseInfo(url);
            if (baseInfo && apiKey && libraryId) {
                try {
                    videoTitle = await downloadService.getVideoTitle(baseInfo.videoId);
                } catch (titleError) {
                    console.log('Could not fetch title, using video ID');
                }
            }
            
            try {
                // Parse the m3u8 URL to get available qualities
                const qualities = await downloadService.getAvailableQualities(url);
                
                if (qualities.length === 0) {
                    continue;
                }

                // Always download best quality (first one - sorted by resolution highest first)
                const bestQuality = qualities[0];
                console.log(`Downloading best quality: ${bestQuality.resolution} for ${videoTitle || url}`);
                
                const job = queueManager.addJob({
                    originalUrl: url,
                    quality: bestQuality,
                    apiKey: apiKey,
                    libraryId: libraryId,
                    videoTitle: videoTitle
                });
                addedJobs.push(job);
            } catch (parseError) {
                console.error(`Error parsing URL ${url}:`, parseError.message);
                // Add a failed job indicator
                addedJobs.push({
                    url: url,
                    error: parseError.message,
                    status: 'failed'
                });
            }
        }

        res.json({ 
            success: true, 
            message: `Added ${addedJobs.filter(j => !j.error).length} download jobs to queue`,
            jobs: addedJobs
        });
        
    } catch (error) {
        console.error('Error adding to queue:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get available qualities for a URL
router.post('/qualities', async (req, res) => {
    try {
        const { url, apiKey } = req.body;
        
        if (!url) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please provide a video URL' 
            });
        }

        const downloadService = new DownloadService(apiKey);
        const qualities = await downloadService.getAvailableQualities(url.trim());
        
        res.json({ 
            success: true, 
            qualities 
        });
        
    } catch (error) {
        console.error('Error getting qualities:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Get queue status
router.get('/status', (req, res) => {
    const queueManager = req.app.get('queueManager');
    res.json({
        success: true,
        status: queueManager.getStatus()
    });
});

// Cancel a specific job
router.post('/cancel/:jobId', (req, res) => {
    const queueManager = req.app.get('queueManager');
    const result = queueManager.cancelJob(req.params.jobId);
    res.json({
        success: result,
        message: result ? 'Job cancelled' : 'Job not found or already completed'
    });
});

// Cancel all pending jobs
router.post('/cancel-all', (req, res) => {
    const queueManager = req.app.get('queueManager');
    queueManager.cancelAllPending();
    res.json({
        success: true,
        message: 'All pending jobs cancelled'
    });
});

// Retry failed job
router.post('/retry/:jobId', (req, res) => {
    const queueManager = req.app.get('queueManager');
    const result = queueManager.retryJob(req.params.jobId);
    res.json({
        success: result,
        message: result ? 'Job queued for retry' : 'Job not found or not in failed state'
    });
});

// Download completed file
router.get('/file/:jobId', (req, res) => {
    const queueManager = req.app.get('queueManager');
    const job = queueManager.getJob(req.params.jobId);
    
    if (!job || !job.outputPath) {
        return res.status(404).json({ 
            success: false, 
            error: 'File not found' 
        });
    }

    if (!fs.existsSync(job.outputPath)) {
        return res.status(404).json({ 
            success: false, 
            error: 'File no longer exists' 
        });
    }

    res.download(job.outputPath);
});

// Clear completed jobs from history
router.post('/clear-completed', (req, res) => {
    const queueManager = req.app.get('queueManager');
    queueManager.clearCompleted();
    res.json({
        success: true,
        message: 'Completed jobs cleared'
    });
});

// Clear cancelled jobs from history
router.post('/clear-cancelled', (req, res) => {
    const queueManager = req.app.get('queueManager');
    queueManager.clearCancelled();
    res.json({
        success: true,
        message: 'Cancelled jobs cleared'
    });
});

module.exports = router;
