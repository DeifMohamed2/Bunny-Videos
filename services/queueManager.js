const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const DownloadService = require('./downloadService');

class QueueManager {
    constructor(io) {
        this.io = io;
        this.jobs = new Map();
        this.activeDownloads = 0;
        this.maxConcurrent = 3;
        // Use temp directory for processing - files will be sent to browser
        this.tempDir = path.join(os.tmpdir(), 'bunny-downloads');
        this.ensureTempDir();
    }

    // Ensure temp directory exists
    ensureTempDir() {
        try {
            if (!fs.existsSync(this.tempDir)) {
                fs.mkdirSync(this.tempDir, { recursive: true });
            }
            console.log('Temp directory ready:', this.tempDir);
            return true;
        } catch (error) {
            console.error('Failed to create temp directory:', error.message);
            this.tempDir = os.tmpdir();
            return false;
        }
    }

    // Add a new download job to the queue
    addJob(jobData) {
        const jobId = uuidv4();
        const videoId = this.extractVideoId(jobData.originalUrl);
        const videoTitle = jobData.videoTitle || `Video_${videoId}`;
        
        const job = {
            id: jobId,
            videoId: videoId,
            videoTitle: videoTitle,
            originalUrl: jobData.originalUrl,
            quality: jobData.quality,
            apiKey: jobData.apiKey,
            status: 'pending',
            progress: 0,
            downloadedBytes: 0,
            speed: 0,
            estimatedTimeRemaining: null,
            currentTime: 0,
            duration: 0,
            method: '',
            error: null,
            outputPath: null,
            fileName: null,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            abortController: null
        };

        this.jobs.set(jobId, job);
        this.emitUpdate();
        this.processQueue();
        
        return {
            id: jobId,
            videoId: videoId,
            videoTitle: videoTitle,
            quality: jobData.quality.resolution,
            status: 'pending'
        };
    }

    // Process the queue - start downloads up to max concurrent
    async processQueue() {
        if (this.activeDownloads >= this.maxConcurrent) {
            return;
        }

        // Find pending jobs
        const pendingJobs = Array.from(this.jobs.values())
            .filter(job => job.status === 'pending')
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        for (const job of pendingJobs) {
            if (this.activeDownloads >= this.maxConcurrent) {
                break;
            }
            
            this.startDownload(job.id);
        }
    }

    // Start downloading a specific job
    async startDownload(jobId) {
        const job = this.jobs.get(jobId);
        if (!job || job.status !== 'pending') {
            return;
        }

        // Ensure temp directory exists
        this.ensureTempDir();

        this.activeDownloads++;
        job.status = 'downloading';
        job.statusText = 'Initializing...';
        job.startedAt = new Date().toISOString();
        job.abortController = new AbortController();
        
        // Generate filename with video title (sanitize for filesystem)
        const safeTitle = this.sanitizeFileName(job.videoTitle);
        const fileName = `${safeTitle}.mp4`;
        job.fileName = fileName;
        // Save to temp directory - will be served to browser
        job.outputPath = path.join(this.tempDir, `${job.id}_${fileName}`);
        
        console.log('Starting download to temp:', job.outputPath);
        
        // Emit update immediately so UI shows "Initializing"
        this.emitUpdate();

        try {
            const downloadService = new DownloadService(job.apiKey);
            
            const result = await downloadService.downloadStream(
                job.quality,
                job.outputPath,
                (progressData) => {
                    // Update job progress
                    job.progress = progressData.progress;
                    job.downloadedBytes = progressData.downloadedBytes;
                    job.speed = progressData.speed;
                    job.estimatedTimeRemaining = progressData.estimatedTimeRemaining;
                    job.currentTime = progressData.currentTime || 0;
                    job.duration = progressData.duration || 0;
                    job.method = progressData.method || 'HLS';
                    job.statusText = progressData.status === 'initializing' ? 'Initializing...' : 'Downloading';
                    
                    this.emitUpdate();
                },
                job.abortController.signal
            );

            job.status = 'completed';
            job.completedAt = new Date().toISOString();
            job.progress = 100;
            job.fileSize = result.fileSize;
            
            // Emit completion event so browser can trigger download
            this.io.emit('download-complete', {
                jobId: job.id,
                fileName: job.fileName,
                fileSize: job.fileSize,
                quality: job.quality.resolution,
                videoId: job.videoId
            });

        } catch (error) {
            if (error.message === 'Download cancelled') {
                job.status = 'cancelled';
            } else {
                job.status = 'failed';
                job.error = error.message;
            }
        } finally {
            this.activeDownloads--;
            job.abortController = null;
            this.emitUpdate();
            this.processQueue();
        }
    }

    // Cancel a specific job
    cancelJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return false;
        }

        if (job.status === 'downloading' && job.abortController) {
            job.abortController.abort();
            return true;
        }

        if (job.status === 'pending') {
            job.status = 'cancelled';
            this.emitUpdate();
            return true;
        }

        return false;
    }

    // Cancel all pending jobs
    cancelAllPending() {
        for (const job of this.jobs.values()) {
            if (job.status === 'pending') {
                job.status = 'cancelled';
            } else if (job.status === 'downloading' && job.abortController) {
                job.abortController.abort();
            }
        }
        this.emitUpdate();
    }

    // Retry a failed job
    retryJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job || job.status !== 'failed') {
            return false;
        }

        job.status = 'pending';
        job.progress = 0;
        job.error = null;
        job.downloadedSegments = 0;
        job.totalSegments = 0;
        job.downloadedBytes = 0;
        job.speed = 0;
        job.estimatedTimeRemaining = null;
        
        this.emitUpdate();
        this.processQueue();
        
        return true;
    }

    // Get a specific job
    getJob(jobId) {
        return this.jobs.get(jobId);
    }

    // Get current queue status
    getStatus() {
        const jobs = Array.from(this.jobs.values()).map(job => ({
            id: job.id,
            videoId: job.videoId,
            videoTitle: job.videoTitle,
            quality: job.quality.resolution,
            status: job.status,
            progress: job.progress,
            downloadedBytes: job.downloadedBytes,
            speed: job.speed,
            estimatedTimeRemaining: job.estimatedTimeRemaining,
            currentTime: job.currentTime,
            duration: job.duration,
            method: job.method,
            error: job.error,
            fileName: job.fileName,
            fileSize: job.fileSize,
            createdAt: job.createdAt,
            completedAt: job.completedAt
        }));

        return {
            activeDownloads: this.activeDownloads,
            maxConcurrent: this.maxConcurrent,
            totalJobs: this.jobs.size,
            pendingJobs: jobs.filter(j => j.status === 'pending').length,
            completedJobs: jobs.filter(j => j.status === 'completed').length,
            failedJobs: jobs.filter(j => j.status === 'failed').length,
            jobs: jobs
        };
    }

    // Clear completed jobs and delete their files
    clearCompleted() {
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'completed') {
                // Delete the temp file if it exists
                if (job.outputPath && fs.existsSync(job.outputPath)) {
                    try {
                        fs.unlinkSync(job.outputPath);
                        console.log('Deleted temp file:', job.outputPath);
                    } catch (e) {
                        console.error('Error deleting temp file:', e.message);
                    }
                }
                this.jobs.delete(jobId);
            }
        }
        this.emitUpdate();
    }

    // Clear cancelled jobs
    clearCancelled() {
        for (const [jobId, job] of this.jobs.entries()) {
            if (job.status === 'cancelled') {
                // Delete the temp file if it exists
                if (job.outputPath && fs.existsSync(job.outputPath)) {
                    try {
                        fs.unlinkSync(job.outputPath);
                        console.log('Deleted temp file:', job.outputPath);
                    } catch (e) {
                        console.error('Error deleting temp file:', e.message);
                    }
                }
                this.jobs.delete(jobId);
            }
        }
        this.emitUpdate();
    }

    // Delete a specific job's temp file after browser download
    cleanupJobFile(jobId) {
        const job = this.jobs.get(jobId);
        if (job && job.outputPath && fs.existsSync(job.outputPath)) {
            try {
                fs.unlinkSync(job.outputPath);
                console.log('Cleaned up temp file after browser download:', job.outputPath);
                job.fileCleanedUp = true;
            } catch (e) {
                console.error('Error cleaning up temp file:', e.message);
            }
        }
    }

    // Emit update to all connected clients
    emitUpdate() {
        this.io.emit('queue-status', this.getStatus());
    }

    // Sanitize filename for filesystem
    sanitizeFileName(name) {
        return name
            .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid chars
            .replace(/\s+/g, '_')            // Replace spaces with underscores
            .replace(/_+/g, '_')             // Remove multiple underscores
            .replace(/^_|_$/g, '')           // Remove leading/trailing underscores
            .substring(0, 100);              // Limit length
    }

    // Extract video ID from URL
    extractVideoId(url) {
        const match = url.match(/([a-f0-9-]{36})/);
        return match ? match[1].substring(0, 8) : 'video_' + Date.now();
    }
}

module.exports = QueueManager;
