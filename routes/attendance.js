const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const { protect, adminOnly } = require('../middleware/auth');

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

// @route POST /api/attendance/login
// @desc Mark attendance login via face recognition
router.post('/login', protect, async (req, res) => {
  try {
    const today = getTodayDate();
    const userId = req.user._id;

    // Check if already logged in today
    const existing = await Attendance.findOne({ userId, date: today });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Already marked attendance for today',
        attendance: existing
      });
    }

    const now = new Date();
    const loginHour = now.getHours();
    const loginMin = now.getMinutes();
    let status = 'present';
    if (loginHour > 9 || (loginHour === 9 && loginMin > 30)) status = 'late';

    const attendance = await Attendance.create({
      userId,
      date: today,
      loginTime: now,
      status,
      isActive: true,
      lastActivity: now,
      loginMethod: req.body.method || 'face'
    });

    await attendance.populate('userId', 'name employeeId email department');

    res.status(201).json({
      success: true,
      message: `Welcome ${req.user.name}! Login recorded at ${now.toLocaleTimeString()}`,
      attendance
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for today' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route POST /api/attendance/logout
// @desc Mark logout
router.post('/logout', protect, async (req, res) => {
  try {
    const today = getTodayDate();
    const userId = req.user._id;

    const attendance = await Attendance.findOne({ userId, date: today });
    if (!attendance) {
      return res.status(404).json({ success: false, message: 'No login record found for today' });
    }
    if (attendance.logoutTime) {
      return res.status(400).json({ success: false, message: 'Already logged out for today', attendance });
    }

    attendance.logoutTime = new Date();
    attendance.isActive = false;
    attendance.logoutMethod = req.body.method || 'face';
    attendance.calculateTotalHours();
    await attendance.save();

    res.json({
      success: true,
      message: `Goodbye ${req.user.name}! Total hours: ${attendance.totalHours}h`,
      attendance
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route PUT /api/attendance/heartbeat
// @desc Update last activity (prevent auto-logout)
router.put('/heartbeat', protect, async (req, res) => {
  try {
    const today = getTodayDate();
    await Attendance.findOneAndUpdate(
      { userId: req.user._id, date: today, isActive: true },
      { lastActivity: new Date() }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/attendance/today
// @desc Get today's attendance status for current user
router.get('/today', protect, async (req, res) => {
  try {
    const today = getTodayDate();
    const attendance = await Attendance.findOne({ userId: req.user._id, date: today })
      .populate('userId', 'name employeeId');
    res.json({ success: true, attendance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/attendance/my-history
// @desc Get attendance history for logged in user
router.get('/my-history', protect, async (req, res) => {
  try {
    const { month, year } = req.query;
    const query = { userId: req.user._id };

    if (month && year) {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
      query.date = { $gte: startDate, $lte: endDate };
    }

    const records = await Attendance.find(query).sort({ date: -1 });
    const summary = computeSummary(records);

    res.json({ success: true, records, summary });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/attendance/all
// @desc Get all attendance (admin)
router.get('/all', protect, adminOnly, async (req, res) => {
  try {
    const { month, year, userId, date, page = 1, limit = 50 } = req.query;
    const query = {};

    if (userId) query.userId = userId;
    if (date) query.date = date;
    if (month && year) {
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
      query.date = { $gte: startDate, $lte: endDate };
    }

    const records = await Attendance.find(query)
      .populate('userId', 'name employeeId email department')
      .sort({ date: -1, loginTime: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Attendance.countDocuments(query);

    res.json({ success: true, records, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/attendance/today-all
// @desc Get today's attendance for all employees (admin)
router.get('/today-all', protect, adminOnly, async (req, res) => {
  try {
    const today = getTodayDate();
    const records = await Attendance.find({ date: today })
      .populate('userId', 'name employeeId email department profileImage');
    res.json({ success: true, records, date: today });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route PUT /api/attendance/:id
// @desc Edit attendance record (admin)
router.put('/:id', protect, adminOnly, async (req, res) => {
  try {
    const { loginTime, logoutTime, status, notes } = req.body;
    const attendance = await Attendance.findById(req.params.id);
    if (!attendance) return res.status(404).json({ success: false, message: 'Record not found' });

    if (loginTime) attendance.loginTime = new Date(loginTime);
    if (logoutTime) attendance.logoutTime = new Date(logoutTime);
    if (status) attendance.status = status;
    if (notes !== undefined) attendance.notes = notes;

    if (attendance.loginTime && attendance.logoutTime) {
      attendance.calculateTotalHours();
    }

    attendance.editedBy = req.user._id;
    attendance.editedAt = new Date();
    await attendance.save();

    res.json({ success: true, attendance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route POST /api/attendance/manual
// @desc Admin adds manual attendance
router.post('/manual', protect, adminOnly, async (req, res) => {
  try {
    const { userId, date, loginTime, logoutTime, status, notes } = req.body;

    const existing = await Attendance.findOne({ userId, date });
    if (existing) return res.status(400).json({ success: false, message: 'Attendance already exists for this date' });

    const attendance = new Attendance({
      userId, date,
      loginTime: loginTime ? new Date(loginTime) : null,
      logoutTime: logoutTime ? new Date(logoutTime) : null,
      status: status || 'present',
      notes: notes || '',
      loginMethod: 'manual',
      editedBy: req.user._id,
      editedAt: new Date()
    });

    if (attendance.loginTime && attendance.logoutTime) {
      attendance.calculateTotalHours();
    }

    await attendance.save();
    res.status(201).json({ success: true, attendance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/attendance/stats
// @desc Get attendance statistics (admin dashboard)
router.get('/stats', protect, adminOnly, async (req, res) => {
  try {
    const today = getTodayDate();
    const User = require('../models/User');

    const totalEmployees = await User.countDocuments({ role: 'employee', isActive: true });
    const todayPresent = await Attendance.countDocuments({ date: today });
    const todayActive = await Attendance.countDocuments({ date: today, isActive: true });

    // This month stats
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const monthRecords = await Attendance.find({ date: { $gte: monthStart } });

    const avgHours = monthRecords.length > 0
      ? (monthRecords.reduce((sum, r) => sum + (r.totalHours || 0), 0) / monthRecords.length).toFixed(1)
      : 0;

    res.json({
      success: true,
      stats: {
        totalEmployees,
        todayPresent,
        todayAbsent: totalEmployees - todayPresent,
        todayActive,
        avgHoursThisMonth: avgHours,
        totalRecordsThisMonth: monthRecords.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

function computeSummary(records) {
  const total = records.length;
  const present = records.filter(r => r.status === 'present').length;
  const late = records.filter(r => r.status === 'late').length;
  const halfDay = records.filter(r => r.status === 'half-day').length;
  const avgHours = total > 0
    ? (records.reduce((s, r) => s + (r.totalHours || 0), 0) / total).toFixed(1)
    : 0;
  return { total, present, late, halfDay, avgHours };
}

module.exports = router;
