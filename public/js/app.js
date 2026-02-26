// Initialize Socket.IO connection
const socket = io();

// DOM Elements
const apiKeyInput = document.getElementById('apiKey');
const libraryIdInput = document.getElementById('libraryId');
const videoUrlsInput = document.getElementById('videoUrls');
const startDownloadBtn = document.getElementById('startDownloadBtn');
const downloadsList = document.getElementById('downloadsList');
const cancelAllBtn = document.getElementById('cancelAllBtn');
const clearCompletedBtn = document.getElementById('clearCompletedBtn');
const clearCancelledBtn = document.getElementById('clearCancelledBtn');
const toastContainer = document.getElementById('toastContainer');

// Stats elements
const activeCount = document.getElementById('activeCount');
const queueCount = document.getElementById('queueCount');
const completedCount = document.getElementById('completedCount');

// Track downloads that have been sent to browser
const browserDownloadsTriggered = new Set();

// Socket.IO event handlers
socket.on('connect', () => {
    console.log('Connected to server');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    showToast('Disconnected from server', 'error');
});

socket.on('queue-status', (status) => {
    updateStats(status);
    renderDownloadsList(status.jobs);
});

socket.on('download-complete', (data) => {
    // Trigger browser download when a file is ready
    if (!browserDownloadsTriggered.has(data.jobId)) {
        browserDownloadsTriggered.add(data.jobId);
        triggerBrowserDownload(data.jobId, data.fileName);
        showToast(`Download ready: ${data.fileName} - Saving to your device!`, 'success');
    }
});

// Update stats display
function updateStats(status) {
    activeCount.textContent = status.activeDownloads;
    queueCount.textContent = status.pendingJobs;
    completedCount.textContent = status.completedJobs;
}

// Render downloads list
function renderDownloadsList(jobs) {
    if (!jobs || jobs.length === 0) {
        downloadsList.innerHTML = `
            <div class="empty-state">
                <svg class="empty-icon" viewBox="0 0 24 24" fill="none">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
                </svg>
                <p>No downloads yet</p>
                <span>Add video URLs above to start downloading</span>
            </div>
        `;
        return;
    }

    // Sort jobs: downloading first, then pending, then completed, then failed
    const sortedJobs = [...jobs].sort((a, b) => {
        const order = { downloading: 0, pending: 1, completed: 2, failed: 3, cancelled: 4 };
        return (order[a.status] || 5) - (order[b.status] || 5);
    });

    downloadsList.innerHTML = sortedJobs.map(job => createDownloadItem(job)).join('');
}

// Create download item HTML
function createDownloadItem(job) {
    const statusClass = `status-${job.status}`;
    let statusText = job.statusText || (job.status.charAt(0).toUpperCase() + job.status.slice(1));
    
    let progressHtml = '';
    if (job.status === 'downloading') {
        const isInitializing = job.statusText === 'Initializing...' || job.progress === 0;
        const speedFormatted = formatSpeed(job.speed);
        const etaFormatted = formatTime(job.estimatedTimeRemaining);
        const bytesFormatted = formatBytes(job.downloadedBytes);
        const durationFormatted = job.duration > 0 ? formatVideoDuration(job.currentTime) + ' / ' + formatVideoDuration(job.duration) : '';
        
        if (isInitializing) {
            progressHtml = `
                <div class="progress-container">
                    <div class="progress-bar">
                        <div class="progress-fill initializing" style="width: 100%"></div>
                    </div>
                    <div class="progress-stats">
                        <span class="progress-percent">Initializing...</span>
                        <span>Connecting to stream</span>
                    </div>
                </div>
            `;
        } else {
            progressHtml = `
                <div class="progress-container">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${job.progress}%"></div>
                    </div>
                    <div class="progress-stats">
                        <span class="progress-percent">${job.progress.toFixed(1)}%</span>
                        ${durationFormatted ? `<span>${durationFormatted}</span>` : ''}
                        <span>${bytesFormatted}</span>
                        <span>${speedFormatted}</span>
                        <span>ETA: ${etaFormatted}</span>
                    </div>
                </div>
            `;
        }
    }

    let actionsHtml = '';
    if (job.status === 'downloading' || job.status === 'pending') {
        actionsHtml = `
            <button class="action-btn danger" onclick="cancelJob('${job.id}')" title="Cancel">
                <svg viewBox="0 0 24 24" fill="none">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
                </svg>
            </button>
        `;
    } else if (job.status === 'failed') {
        actionsHtml = `
            <button class="action-btn success" onclick="retryJob('${job.id}')" title="Retry">
                <svg viewBox="0 0 24 24" fill="none">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/>
                </svg>
            </button>
        `;
    } else if (job.status === 'completed') {
        actionsHtml = `
            <button class="action-btn success" onclick="downloadFile('${job.id}', '${job.fileName}')" title="Download Again">
                <svg viewBox="0 0 24 24" fill="none">
                    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
                </svg>
            </button>
        `;
    }

    const errorHtml = job.error ? `<div class="download-error" style="color: var(--danger); font-size: 0.8rem; margin-top: 8px;">${job.error}</div>` : '';
    const fileSizeHtml = job.fileSize ? `<span>${formatBytes(job.fileSize)}</span>` : '';
    
    // Use videoTitle if available, fallback to videoId
    const displayName = job.videoTitle || job.videoId;

    return `
        <div class="download-item">
            <div class="download-header">
                <div class="download-info">
                    <div class="download-name">${displayName}</div>
                    <div class="download-meta">
                        <span class="status-badge ${statusClass}">${statusText}</span>
                        ${fileSizeHtml}
                    </div>
                </div>
                <div class="download-actions">
                    ${actionsHtml}
                </div>
            </div>
            ${progressHtml}
            ${errorHtml}
        </div>
    `;
}

// Start downloads
async function startDownload() {
    const urls = getVideoUrls();
    const apiKey = apiKeyInput.value.trim();
    const libraryId = libraryIdInput.value.trim();

    if (urls.length === 0) {
        showToast('Please enter at least one video URL', 'error');
        return;
    }

    startDownloadBtn.disabled = true;
    startDownloadBtn.innerHTML = '<span class="spinner"></span> Starting...';

    // Warn if API key or Library ID missing for title fetching
    if (!apiKey || !libraryId) {
        showToast('Tip: Add API Key & Library ID to auto-fetch video titles', 'info');
    }

    try {
        const response = await fetch('/api/download/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls, apiKey, libraryId })
        });

        const data = await response.json();

        if (data.success) {
            showToast(data.message + ' - Files will download to your browser!', 'success');
            videoUrlsInput.value = '';
        } else {
            showToast(data.error || 'Failed to add downloads', 'error');
        }
    } catch (error) {
        showToast('Failed to start downloads: ' + error.message, 'error');
    } finally {
        startDownloadBtn.disabled = false;
        startDownloadBtn.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24" fill="none">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
            </svg>
            Start Download
        `;
    }
}

// Get video URLs from textarea
function getVideoUrls() {
    return videoUrlsInput.value
        .split('\n')
        .map(url => url.trim())
        .filter(url => url.length > 0);
}

// Cancel a job
async function cancelJob(jobId) {
    try {
        const response = await fetch(`/api/download/cancel/${jobId}`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showToast('Download cancelled', 'info');
        }
    } catch (error) {
        showToast('Failed to cancel: ' + error.message, 'error');
    }
}

// Retry a job
async function retryJob(jobId) {
    try {
        const response = await fetch(`/api/download/retry/${jobId}`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showToast('Download queued for retry', 'success');
        }
    } catch (error) {
        showToast('Failed to retry: ' + error.message, 'error');
    }
}

// Cancel all downloads
async function cancelAll() {
    try {
        const response = await fetch('/api/download/cancel-all', {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showToast('All downloads cancelled', 'info');
        }
    } catch (error) {
        showToast('Failed to cancel all: ' + error.message, 'error');
    }
}

// Clear completed downloads
async function clearCompleted() {
    try {
        const response = await fetch('/api/download/clear-completed', {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            browserDownloadsTriggered.clear();
            showToast('Completed downloads cleared', 'info');
        }
    } catch (error) {
        showToast('Failed to clear: ' + error.message, 'error');
    }
}

// Clear cancelled downloads
async function clearCancelled() {
    try {
        const response = await fetch('/api/download/clear-cancelled', {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showToast('Cancelled downloads cleared', 'info');
        }
    } catch (error) {
        showToast('Failed to clear: ' + error.message, 'error');
    }
}

// Trigger browser download
function triggerBrowserDownload(jobId, fileName) {
    const link = document.createElement('a');
    link.href = `/api/download/file/${jobId}`;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Download file (manual trigger)
function downloadFile(jobId, fileName) {
    triggerBrowserDownload(jobId, fileName);
    showToast('Downloading: ' + fileName, 'info');
}

// Format bytes
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format speed
function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond === 0) return '0 B/s';
    return formatBytes(bytesPerSecond) + '/s';
}

// Format bandwidth
function formatBandwidth(bps) {
    if (!bps || bps === 0) return '';
    const mbps = bps / 1000000;
    return mbps.toFixed(2) + ' Mbps';
}

// Format time
function formatTime(seconds) {
    if (!seconds || seconds === Infinity || isNaN(seconds)) return '--:--';
    
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format video duration (for progress display)
function formatVideoDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconPath = '';
    switch (type) {
        case 'success':
            iconPath = 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';
            break;
        case 'error':
            iconPath = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z';
            break;
        default:
            iconPath = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z';
    }
    
    toast.innerHTML = `
        <svg class="toast-icon" viewBox="0 0 24 24" fill="none">
            <path d="${iconPath}" fill="currentColor"/>
        </svg>
        <span class="toast-message">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
            </svg>
        </button>
    `;
    
    toastContainer.appendChild(toast);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (toast.parentElement) {
            toast.remove();
        }
    }, 5000);
}

// Event listeners
startDownloadBtn.addEventListener('click', startDownload);
cancelAllBtn.addEventListener('click', cancelAll);
clearCompletedBtn.addEventListener('click', clearCompleted);
clearCancelledBtn.addEventListener('click', clearCancelled);

// Keyboard shortcuts
videoUrlsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
        startDownload();
    }
});

// Initialize
console.log('🐰 Bunny Video Downloader initialized');
