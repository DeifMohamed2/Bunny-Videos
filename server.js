const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const downloadRouter = require('./routes/download');
const QueueManager = require('./services/queueManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize Queue Manager with Socket.IO
const queueManager = new QueueManager(io);
app.set('queueManager', queueManager);
app.set('io', io);

// Routes
app.get('/', (req, res) => {
    res.render('index');
});

app.use('/api/download', downloadRouter);

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send current queue status to newly connected client
    socket.emit('queue-status', queueManager.getStatus());
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🐰 Bunny Video Downloader running at http://localhost:${PORT}`);
});

module.exports = { app, io };
