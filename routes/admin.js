const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const { protect, adminOnly } = require('../middleware/auth');

// @route GET /api/admin/dashboard
router.get('/dashboard', protect, adminOnly, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [
      totalEmployees,
      totalAdmins,
      todayRecords,
      monthRecords,
      recentLogins
    ] = await Promise.all([
      User.countDocuments({ role: 'employee', isActive: true }),
      User.countDocuments({ role: 'admin', isActive: true }),
      Attendance.find({ date: today }).populate('userId', 'name employeeId department profileImage'),
      Attendance.find({ date: { $gte: monthStart } }),
      Attendance.find({ date: today })
        .populate('userId', 'name employeeId department')
        .sort({ loginTime: -1 })
        .limit(10)
    ]);

    const presentToday = todayRecords.length;
    const activeNow = todayRecords.filter(r => r.isActive).length;
    const lateToday = todayRecords.filter(r => r.status === 'late').length;
    const avgHoursMonth = monthRecords.length > 0
      ? (monthRecords.reduce((s, r) => s + r.totalHours, 0) / monthRecords.length).toFixed(1)
      : 0;

    // Department-wise today
    const deptMap = {};
    for (const r of todayRecords) {
      const dept = r.userId?.department || 'General';
      deptMap[dept] = (deptMap[dept] || 0) + 1;
    }

    res.json({
      success: true,
      dashboard: {
        totalEmployees,
        totalAdmins,
        presentToday,
        absentToday: totalEmployees - presentToday,
        activeNow,
        lateToday,
        avgHoursMonth,
        byDepartment: deptMap,
        recentLogins
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/admin/monthly-report
router.get('/monthly-report', protect, adminOnly, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const endDate = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const employees = await User.find({ role: 'employee', isActive: true });
    const allAttendance = await Attendance.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('userId', 'name employeeId department');

    const report = employees.map(emp => {
      const empRecords = allAttendance.filter(r => r.userId?._id?.toString() === emp._id.toString());
      const present = empRecords.filter(r => ['present', 'late'].includes(r.status)).length;
      const late = empRecords.filter(r => r.status === 'late').length;
      const halfDay = empRecords.filter(r => r.status === 'half-day').length;
      const totalHours = empRecords.reduce((s, r) => s + r.totalHours, 0);

      return {
        employeeId: emp.employeeId,
        name: emp.name,
        department: emp.department,
        totalDays: lastDay,
        presentDays: present,
        absentDays: lastDay - empRecords.length,
        lateDays: late,
        halfDays: halfDay,
        totalHours: totalHours.toFixed(1),
        avgHours: empRecords.length > 0 ? (totalHours / empRecords.length).toFixed(1) : 0,
        records: empRecords
      };
    });

    res.json({ success: true, report, month: m, year: y, startDate, endDate });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route DELETE /api/admin/users/:id
router.delete('/users/:id', protect, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    }
    await User.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ userId: req.params.id });
    res.json({ success: true, message: 'User and attendance records deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route PUT /api/admin/users/:id
router.put('/users/:id', protect, adminOnly, async (req, res) => {
  try {
    const { name, employeeId, email, department, role, isActive } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, employeeId, email, department, role, isActive },
      { new: true, runValidators: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
