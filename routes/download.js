const express = require('express');
const router = express.Router();
const DownloadService = require('../services/downloadService');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// Add video(s) to download queue
router.post('/add', async (req, res) => {
    try {
        const { urls, apiKey, libraryId } = req.body;
        
        const queueManager = req.app.get('queueManager');
        
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

// Download completed file to browser
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
            error: 'File no longer exists on server' 
        });
    }

    // Get file stats
    const stat = fs.statSync(job.outputPath);
    
    // Set headers for browser download
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.fileName)}"`);
    
    // Stream the file to browser
    const fileStream = fs.createReadStream(job.outputPath);
    
    fileStream.on('end', () => {
        // Clean up temp file after successful download
        setTimeout(() => {
            queueManager.cleanupJobFile(req.params.jobId);
        }, 1000);
    });
    
    fileStream.on('error', (err) => {
        console.error('Error streaming file:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Error streaming file' });
        }
    });
    
    fileStream.pipe(res);
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

// Advanced proxy endpoint for Bunny HLS/MP4 with AccessKey header and playlist rewriting
const urlLib = require('url');
router.get('/proxy', async (req, res) => {
    const url = req.query.url;
    const apiKey = req.query.apiKey || req.headers['x-bunny-apikey'] || req.get('x-bunny-apikey');
    if (!url) {
        return res.status(400).send('Missing url');
    }
    try {
        const headers = {};
        if (apiKey) headers['AccessKey'] = apiKey;
        // Forward range and user-agent headers for segment/MP4 requests
        if (req.headers['range']) headers['Range'] = req.headers['range'];
        if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

        // If playlist (.m3u8), rewrite segment URLs to go through proxy
        if (url.endsWith('.m3u8')) {
            const response = await axios.get(url, { headers, timeout: 30000 });
            let playlist = response.data;
            // Rewrite all segment URLs (lines not starting with #)
            const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
            playlist = playlist.split('\n').map(line => {
                line = line.trim();
                if (!line || line.startsWith('#')) return line;
                // Absolute URL? Proxy as is. Relative? Make absolute then proxy.
                let absUrl = line;
                if (!/^https?:\/\//.test(line)) absUrl = baseUrl + line;
                // Re-proxy
                const proxied = `/api/download/proxy?url=${encodeURIComponent(absUrl)}${apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ''}`;
                return proxied;
            }).join('\n');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(playlist);
        } else {
            // For segments or MP4, just stream with all headers and support range
            const response = await axios({
                method: 'GET',
                url,
                headers,
                responseType: 'stream',
                timeout: 60000,
                decompress: false // Don't gunzip or decompress
            });
            // Forward all relevant headers
            for (const [key, value] of Object.entries(response.headers)) {
                // Don't send transfer-encoding: chunked, let Node handle it
                if (key.toLowerCase() === 'transfer-encoding') continue;
                res.setHeader(key, value);
            }
            res.status(response.status);
            response.data.pipe(res);
        }
    } catch (err) {
        res.status(502).send('Proxy error: ' + (err.response?.status || err.message));
    }
});

module.exports = router;
