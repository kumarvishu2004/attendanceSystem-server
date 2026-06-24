const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');
const path = require('path');

// Load .env — works whether or not the file exists
dotenv.config();

// Provide safe defaults so server never crashes on missing env vars
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_please_change_in_production';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/face_attendance';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
process.env.PORT = process.env.PORT || '5000';

const app = express();

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    const allowed = [
      process.env.CLIENT_URL,
      "https://attendance-system-4qmr.vercel.app",
    ];
    if (allowed.includes(origin)) return callback(null, true);
    callback(null, true); // permissive in dev — tighten in production
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/export', require('./routes/export'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Face Attendance Server Running' });
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/face_attendance')
  .then(() => {
    console.log('✅ MongoDB Connected');
    
    // Auto-logout cron job: runs every minute to check for inactive sessions
    cron.schedule('* * * * *', async () => {
      const { autoLogoutInactive } = require('./utils/attendanceUtils');
      await autoLogoutInactive();
    });

    // Daily report cron: runs at midnight
    cron.schedule('0 0 * * *', async () => {
      console.log('📅 Running daily attendance cleanup...');
    });

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

// Global error handler — catches unhandled errors from all routes
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

module.exports = app;
