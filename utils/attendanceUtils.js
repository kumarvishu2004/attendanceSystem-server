const Attendance = require('../models/Attendance');

const AUTO_LOGOUT_MINUTES = 30; // auto logout after 30 min inactivity

async function autoLogoutInactive() {
  try {
    const cutoff = new Date(Date.now() - AUTO_LOGOUT_MINUTES * 60 * 1000);
    const today = new Date().toISOString().split('T')[0];

    const staleRecords = await Attendance.find({
      date: today,
      isActive: true,
      lastActivity: { $lt: cutoff },
      logoutTime: null
    });

    for (const record of staleRecords) {
      record.logoutTime = record.lastActivity; // use last known activity as logout
      record.isActive = false;
      record.logoutMethod = 'auto';
      record.calculateTotalHours();
      await record.save();
      console.log(`🔄 Auto-logout: ${record.userId} at ${record.logoutTime}`);
    }
  } catch (err) {
    console.error('Auto-logout error:', err.message);
  }
}

module.exports = { autoLogoutInactive };
