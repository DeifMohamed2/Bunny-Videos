const express = require('express');
const router = express.Router();
const DownloadService = require('../services/downloadService');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Set download path (creates directory if needed)
router.post('/set-path', (req, res) => {
    try {
        const { downloadPath } = req.body;
        const queueManager = req.app.get('queueManager');
        
        if (!downloadPath || !downloadPath.trim()) {
            return res.status(400).json({ success: false, error: 'No path provided' });
        }

        const normalizedPath = path.normalize(downloadPath.trim());

        // Try to create directory if it doesn't exist
        try {
            if (!fs.existsSync(normalizedPath)) {
                fs.mkdirSync(normalizedPath, { recursive: true });
            }
        } catch (mkdirError) {
            return res.status(400).json({ success: false, error: 'Cannot create directory: ' + mkdirError.message });
        }

        // Check if path is writable
        try {
            const testFile = path.join(normalizedPath, '.write-test-' + Date.now());
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
        } catch (err) {
            return res.status(400).json({ success: false, error: 'Path is not writable' });
        }

        queueManager.setDownloadDir(normalizedPath);
        res.json({ success: true, path: normalizedPath });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get current download path
router.get('/current-path', (req, res) => {
    const queueManager = req.app.get('queueManager');
    res.json({ success: true, path: queueManager.getDownloadDir() });
});

// Add video(s) to download queue
router.post('/add', async (req, res) => {
    try {
        const { urls, apiKey, libraryId } = req.body;
        
        const queueManager = req.app.get('queueManager');
        
        // Check if download path is set
        if (!queueManager.getDownloadDir()) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please set a download path first' 
            });
        }
        
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please provide at least one video URL' 
            });
        }

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
