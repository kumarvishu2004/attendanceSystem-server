const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: String, // stored as YYYY-MM-DD for easy querying
    required: true
  },
  loginTime: {
    type: Date,
    default: null
  },
  logoutTime: {
    type: Date,
    default: null
  },
  totalHours: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['present', 'absent', 'half-day', 'late', 'on-leave'],
    default: 'present'
  },
  isActive: {
    type: Boolean,
    default: true  // currently logged in
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  loginMethod: {
    type: String,
    enum: ['face', 'manual'],
    default: 'face'
  },
  logoutMethod: {
    type: String,
    enum: ['face', 'manual', 'auto', null],
    default: null
  },
  notes: {
    type: String,
    default: ''
  },
  editedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  editedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Compound index to ensure one record per user per day
attendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });
attendanceSchema.index({ userId: 1 });

// Virtual for formatted total hours
attendanceSchema.virtual('totalHoursFormatted').get(function() {
  const h = Math.floor(this.totalHours);
  const m = Math.round((this.totalHours - h) * 60);
  return `${h}h ${m}m`;
});

// Calculate total hours when logout is set
attendanceSchema.methods.calculateTotalHours = function() {
  if (this.loginTime && this.logoutTime) {
    const diff = this.logoutTime - this.loginTime;
    this.totalHours = parseFloat((diff / (1000 * 60 * 60)).toFixed(2));
    
    // Update status based on hours
    if (this.totalHours < 4) {
      this.status = 'half-day';
    } else {
      // Check if late (after 9:30 AM)
      const loginHour = new Date(this.loginTime).getHours();
      const loginMin = new Date(this.loginTime).getMinutes();
      if (loginHour > 9 || (loginHour === 9 && loginMin > 30)) {
        this.status = 'late';
      } else {
        this.status = 'present';
      }
    }
  }
};

module.exports = mongoose.model('Attendance', attendanceSchema);
