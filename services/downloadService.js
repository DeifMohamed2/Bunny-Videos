const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

class DownloadService {
    constructor(apiKey = null, libraryId = null) {
        this.apiKey = apiKey;
        this.libraryId = libraryId;
    }

    // Fetch video title from Bunny Stream API
    async getVideoTitle(videoId) {
        if (!this.apiKey || !this.libraryId) {
            console.log('No API key or Library ID provided, cannot fetch title');
            return null;
        }

        try {
            const response = await axios.get(
                `https://video.bunnycdn.com/library/${this.libraryId}/videos/${videoId}`,
                {
                    headers: {
                        'AccessKey': this.apiKey,
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.title) {
                console.log('Fetched video title:', response.data.title);
                return response.data.title;
            }
            return null;
        } catch (error) {
            console.error('Error fetching video title:', error.message);
            return null;
        }
    }

    // Parse m3u8 playlist to get available qualities
    async getAvailableQualities(playlistUrl) {
        try {
            const headers = {};
            if (this.apiKey) {
                headers['AccessKey'] = this.apiKey;
            }

            const response = await axios.get(playlistUrl, { 
                headers,
                timeout: 30000 
            });
            
            const content = response.data;
            const qualities = [];
            const lines = content.split('\n');
            
            // Extract base URL and video ID for MP4 fallback URLs
            const baseInfo = this.extractBaseInfo(playlistUrl);
            
            let currentQuality = null;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                if (line.startsWith('#EXT-X-STREAM-INF:')) {
                    // Parse resolution and bandwidth
                    const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
                    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                    
                    if (resMatch) {
                        currentQuality = {
                            width: parseInt(resMatch[1]),
                            height: parseInt(resMatch[2]),
                            resolution: resMatch[2] + 'p',
                            bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1]) : 0
                        };
                    }
                } else if (currentQuality && line && !line.startsWith('#')) {
                    // This is the URL for the quality
                    let qualityUrl = line;
                    
                    // Handle relative URLs
                    if (!qualityUrl.startsWith('http')) {
                        const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
                        qualityUrl = baseUrl + qualityUrl;
                    }
                    
                    currentQuality.url = qualityUrl;
                    
                    // Add MP4 fallback URL if available
                    if (baseInfo) {
                        currentQuality.mp4FallbackUrl = baseInfo.baseUrl + '/' + baseInfo.videoId + '/play_' + currentQuality.height + 'p.mp4';
                        currentQuality.originalUrl = baseInfo.baseUrl + '/' + baseInfo.videoId + '/original';
                    }
                    
                    qualities.push(currentQuality);
                    currentQuality = null;
                }
            }

            // Sort by resolution (highest first)
            qualities.sort((a, b) => b.height - a.height);
            
            return qualities;
        } catch (error) {
            console.error('Error fetching playlist:', error.message);
            throw new Error('Failed to fetch playlist: ' + error.message);
        }
    }

    // Extract base URL and video ID from playlist URL
    extractBaseInfo(playlistUrl) {
        try {
            // Pattern: https://vz-xxx.b-cdn.net/video-id/playlist.m3u8
            const match = playlistUrl.match(/^(https?:\/\/[^\/]+)\/([a-f0-9-]{36})\/playlist\.m3u8/i);
            if (match) {
                return {
                    baseUrl: match[1],
                    videoId: match[2]
                };
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // Main download method - tries MP4 fallback first, then HLS via ffmpeg
    async downloadStream(quality, outputPath, onProgress, signal) {
        const headers = {};
        if (this.apiKey) {
            headers['AccessKey'] = this.apiKey;
        }

        // Method 1: Try MP4 fallback URL first (fastest, most compatible)
        if (quality.mp4FallbackUrl) {
            try {
                console.log('Trying MP4 fallback: ' + quality.mp4FallbackUrl);
                const result = await this.downloadDirectMP4(quality.mp4FallbackUrl, outputPath, onProgress, signal, headers);
                if (result.success) {
                    return result;
                }
            } catch (error) {
                console.log('MP4 fallback failed: ' + error.message + ', trying HLS...');
            }
        }

        // Method 2: Use ffmpeg to download HLS stream (most reliable)
        // IMPORTANT: Use quality.url (specific quality stream), NOT playlistUrl (master playlist)
        const hlsUrl = quality.url;
        console.log('Downloading via HLS/ffmpeg: ' + hlsUrl + ' (Quality: ' + quality.resolution + ')');
        return await this.downloadViaFFmpeg(hlsUrl, outputPath, onProgress, signal);
    }

    // Download direct MP4 file
    async downloadDirectMP4(url, outputPath, onProgress, signal, headers = {}) {
        const response = await axios({
            method: 'GET',
            url: url,
            headers,
            responseType: 'stream',
            timeout: 30000,
            signal
        });

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(outputPath);

            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                
                if (onProgress && totalBytes > 0) {
                    const progress = (downloadedBytes / totalBytes) * 100;
                    const elapsedTime = (Date.now() - startTime) / 1000;
                    const speed = downloadedBytes / elapsedTime;
                    const remaining = (totalBytes - downloadedBytes) / speed;

                    onProgress({
                        progress: Math.round(progress * 100) / 100,
                        downloadedBytes,
                        totalBytes,
                        speed,
                        estimatedTimeRemaining: Math.round(remaining),
                        method: 'MP4 Direct'
                    });
                }
            });

            response.data.pipe(writer);

            writer.on('finish', () => {
                const stats = fs.statSync(outputPath);
                resolve({
                    success: true,
                    outputPath,
                    fileSize: stats.size,
                    duration: (Date.now() - startTime) / 1000,
                    method: 'MP4 Direct'
                });
            });

            writer.on('error', reject);
            response.data.on('error', reject);

            if (signal) {
                signal.addEventListener('abort', () => {
                    writer.destroy();
                    reject(new Error('Download cancelled'));
                });
            }
        });
    }

    // Download via ffmpeg (HLS to MP4) - THE CORRECT WAY
    async downloadViaFFmpeg(playlistUrl, outputPath, onProgress, signal) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            let duration = 0;
            let currentTime = 0;
            let lastBytes = 0;
            let hasStarted = false;

            // Send immediate "initializing" progress
            if (onProgress) {
                onProgress({
                    progress: 0,
                    downloadedBytes: 0,
                    speed: 0,
                    estimatedTimeRemaining: 0,
                    currentTime: 0,
                    duration: 0,
                    method: 'Initializing...',
                    status: 'initializing'
                });
            }

            // Build ffmpeg arguments with optimizations for faster startup
            const args = [
                '-y',                          // Overwrite output
                '-analyzeduration', '1000000', // Reduce analysis time (1 second)
                '-probesize', '1000000',       // Reduce probe size (1MB)
                '-i', playlistUrl,             // Input HLS URL directly
                '-c', 'copy',                  // Copy codecs (no re-encoding, fast!)
                '-bsf:a', 'aac_adtstoasc',    // Fix audio for MP4 container
                '-movflags', '+faststart',     // Enable fast start for web
                outputPath
            ];

            console.log('Running: ffmpeg ' + args.join(' '));

            const ffmpeg = spawn(ffmpegPath, args);

            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;

                // Parse duration from input analysis
                const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (durationMatch) {
                    duration = parseInt(durationMatch[1]) * 3600 + 
                               parseInt(durationMatch[2]) * 60 + 
                               parseInt(durationMatch[3]) +
                               parseInt(durationMatch[4]) / 100;
                }

                // Parse current time progress
                const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (timeMatch) {
                    currentTime = parseInt(timeMatch[1]) * 3600 + 
                                  parseInt(timeMatch[2]) * 60 + 
                                  parseInt(timeMatch[3]) +
                                  parseInt(timeMatch[4]) / 100;
                }

                // Parse downloaded size
                const sizeMatch = output.match(/size=\s*(\d+)kB/);
                if (sizeMatch) {
                    lastBytes = parseInt(sizeMatch[1]) * 1024;
                }

                // Parse speed
                const speedMatch = output.match(/speed=\s*([\d.]+)x/);
                
                if (onProgress) {
                    const progress = duration > 0 ? Math.min((currentTime / duration) * 100, 99.9) : 0;
                    const elapsedTime = (Date.now() - startTime) / 1000;
                    const downloadSpeed = elapsedTime > 0 ? lastBytes / elapsedTime : 0;
                    const estimatedRemaining = duration > 0 && currentTime > 0 
                        ? ((duration - currentTime) / currentTime) * elapsedTime 
                        : 0;

                    onProgress({
                        progress: Math.round(progress * 100) / 100,
                        downloadedBytes: lastBytes,
                        speed: downloadSpeed,
                        estimatedTimeRemaining: Math.round(estimatedRemaining),
                        currentTime: Math.round(currentTime),
                        duration: Math.round(duration),
                        method: 'HLS/ffmpeg'
                    });
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    if (fs.existsSync(outputPath)) {
                        const stats = fs.statSync(outputPath);
                        console.log('FFmpeg completed successfully. File size: ' + stats.size);
                        resolve({
                            success: true,
                            outputPath,
                            fileSize: stats.size,
                            duration: (Date.now() - startTime) / 1000,
                            method: 'HLS/ffmpeg'
                        });
                    } else {
                        reject(new Error('FFmpeg completed but output file not found'));
                    }
                } else {
                    console.error('FFmpeg failed with code ' + code);
                    console.error('FFmpeg stderr:', stderr.slice(-1000));
                    reject(new Error('FFmpeg exited with code ' + code));
                }
            });

            ffmpeg.on('error', (error) => {
                reject(new Error('FFmpeg error: ' + error.message));
            });

            // Handle abort signal
            if (signal) {
                signal.addEventListener('abort', () => {
                    ffmpeg.kill('SIGTERM');
                    // Clean up partial file
                    if (fs.existsSync(outputPath)) {
                        try { fs.unlinkSync(outputPath); } catch (e) {}
                    }
                    reject(new Error('Download cancelled'));
                });
            }
        });
    }

    // Extract video ID from Bunny CDN URL
    extractVideoId(url) {
        const match = url.match(/([a-f0-9-]{36})/);
        return match ? match[1] : uuidv4();
    }
}

module.exports = DownloadService;
