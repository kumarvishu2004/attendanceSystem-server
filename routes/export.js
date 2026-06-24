const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');
const https = require('https');

// ─── Helper: push data to Google Sheets via API ───────────────────────────────
async function createGoogleSheet(title, headers, rows, serviceAccountKey) {
  const { google } = require('googleapis');

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // 1) Create a new spreadsheet
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: 'Monthly Summary' } },
        { properties: { title: 'Daily Detail' } },
        { properties: { title: 'Editable Template' } },
      ],
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // 2) Write data into sheets
  const requests = [];

  // Write each sheet's data
  for (const { sheetTitle, sheetHeaders, sheetRows } of rows) {
    const sheetData = [sheetHeaders, ...sheetRows];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: sheetData },
    });
  }

  // 3) Make it publicly accessible (anyone with link can edit)
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'writer',
      type: 'anyone',
    },
  });

  return { spreadsheetId, spreadsheetUrl };
}

// @route GET /api/export/monthly
// @desc  Download monthly Excel (traditional download)
router.get('/monthly', protect, adminOnly, async (req, res) => {
  try {
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const monthName = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long' });

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay   = new Date(y, m, 0).getDate();
    const endDate   = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const employees  = await User.find({ role: 'employee', isActive: true });
    const attendance = await Attendance.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('userId', 'name employeeId department');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Face Attendance System';
    workbook.created = new Date();

    // Sheet 1: Monthly Summary
    const summarySheet = workbook.addWorksheet('Monthly Summary', {
      pageSetup: { paperSize: 9, orientation: 'landscape' }
    });
    summarySheet.mergeCells('A1:K1');
    const titleCell = summarySheet.getCell('A1');
    titleCell.value = `Attendance Report - ${monthName} ${y}`;
    titleCell.font  = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    summarySheet.getRow(1).height = 40;

    const headers = ['Emp ID','Name','Department','Total Days','Present','Absent','Late','Half Day','Total Hours','Avg Hours/Day','Status'];
    const headerRow = summarySheet.addRow(headers);
    headerRow.eachCell(cell => {
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    summarySheet.columns = [
      {width:12},{width:22},{width:16},{width:11},{width:10},
      {width:10},{width:10},{width:10},{width:14},{width:14},{width:12}
    ];

    for (const emp of employees) {
      const empRecs    = attendance.filter(r => r.userId?._id?.toString() === emp._id.toString());
      const present    = empRecs.filter(r => ['present','late'].includes(r.status)).length;
      const late       = empRecs.filter(r => r.status === 'late').length;
      const halfDay    = empRecs.filter(r => r.status === 'half-day').length;
      const totalHours = empRecs.reduce((s, r) => s + r.totalHours, 0);
      const absent     = lastDay - empRecs.length;
      const pct        = Math.round((present / lastDay) * 100);
      const statusText = pct >= 90 ? 'Excellent' : pct >= 75 ? 'Good' : pct >= 60 ? 'Average' : 'Poor';

      const row = summarySheet.addRow([
        emp.employeeId, emp.name, emp.department, lastDay, present,
        absent, late, halfDay, totalHours.toFixed(1),
        empRecs.length > 0 ? (totalHours / empRecs.length).toFixed(1) : '0',
        statusText
      ]);
      const colors = { Excellent:'FF22C55E', Good:'FF3B82F6', Average:'FFF59E0B', Poor:'FFEF4444' };
      row.getCell(11).font = { bold: true, color: { argb: colors[statusText] } };
      row.eachCell(cell => {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { bottom: { style:'thin', color:{ argb:'FFE2E8F0' } } };
      });
    }

    // Sheet 2: Daily
    const dailySheet = workbook.addWorksheet('Daily Attendance');
    dailySheet.mergeCells('A1:I1');
    const dt = dailySheet.getCell('A1');
    dt.value = `Daily Attendance Detail - ${monthName} ${y}`;
    dt.font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    dt.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    dt.alignment = { horizontal: 'center', vertical: 'middle' };
    dailySheet.getRow(1).height = 35;

    const dh = dailySheet.addRow(['Date','Emp ID','Name','Department','Login Time','Logout Time','Hours','Status','Notes']);
    dh.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF475569' } };
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    dailySheet.columns = [
      {width:12},{width:12},{width:22},{width:14},
      {width:14},{width:14},{width:10},{width:12},{width:20}
    ];

    const sortedAtt = attendance.sort((a,b) => a.date.localeCompare(b.date));
    for (const rec of sortedAtt) {
      dailySheet.addRow([
        rec.date, rec.userId?.employeeId||'N/A', rec.userId?.name||'N/A',
        rec.userId?.department||'N/A',
        rec.loginTime  ? new Date(rec.loginTime).toLocaleTimeString()  : '-',
        rec.logoutTime ? new Date(rec.logoutTime).toLocaleTimeString() : '-',
        rec.totalHours||0, rec.status, rec.notes||''
      ]);
    }

    // Sheet 3: Editable Template
    const editSheet = workbook.addWorksheet('Editable Template');
    editSheet.mergeCells('A1:H1');
    const et = editSheet.getCell('A1');
    et.value = `⚠ Editable Attendance - ${monthName} ${y}`;
    et.font  = { bold: true, size: 12, color: { argb: 'FF92400E' } };
    et.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    et.alignment = { horizontal: 'center', vertical: 'middle' };
    editSheet.addRow(['Emp ID','Name','Date','Login (HH:MM)','Logout (HH:MM)','Total Hours','Status','Notes']);
    editSheet.columns = [
      {width:12},{width:22},{width:12},{width:18},{width:18},{width:14},{width:14},{width:24}
    ];
    for (const rec of sortedAtt) {
      editSheet.addRow([
        rec.userId?.employeeId||'', rec.userId?.name||'', rec.date,
        rec.loginTime  ? `${String(new Date(rec.loginTime).getHours()).padStart(2,'0')}:${String(new Date(rec.loginTime).getMinutes()).padStart(2,'0')}`  : '',
        rec.logoutTime ? `${String(new Date(rec.logoutTime).getHours()).padStart(2,'0')}:${String(new Date(rec.logoutTime).getMinutes()).padStart(2,'0')}` : '',
        rec.totalHours||0, rec.status, rec.notes||''
      ]);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_${monthName}_${y}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route POST /api/export/google-sheet
// @desc  Create a live Google Sheet and return its shareable link
router.post('/google-sheet', protect, adminOnly, async (req, res) => {
  try {
    const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!GOOGLE_SERVICE_ACCOUNT) {
      return res.status(400).json({
        success: false,
        message: 'Google Service Account not configured. Add GOOGLE_SERVICE_ACCOUNT_JSON to server .env'
      });
    }

    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid GOOGLE_SERVICE_ACCOUNT_JSON format' });
    }

    const { month, year } = req.body;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const monthName = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long' });

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay   = new Date(y, m, 0).getDate();
    const endDate   = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const employees  = await User.find({ role: 'employee', isActive: true });
    const attendance = await Attendance.find({
      date: { $gte: startDate, $lte: endDate }
    }).populate('userId', 'name employeeId department');

    // Build row data for each sheet
    const summaryRows = [];
    for (const emp of employees) {
      const empRecs    = attendance.filter(r => r.userId?._id?.toString() === emp._id.toString());
      const present    = empRecs.filter(r => ['present','late'].includes(r.status)).length;
      const late       = empRecs.filter(r => r.status === 'late').length;
      const halfDay    = empRecs.filter(r => r.status === 'half-day').length;
      const totalHours = empRecs.reduce((s, r) => s + r.totalHours, 0);
      const absent     = lastDay - empRecs.length;
      const pct        = Math.round((present / lastDay) * 100);
      const statusText = pct >= 90 ? 'Excellent' : pct >= 75 ? 'Good' : pct >= 60 ? 'Average' : 'Poor';
      summaryRows.push([
        emp.employeeId, emp.name, emp.department, lastDay, present,
        absent, late, halfDay, parseFloat(totalHours.toFixed(1)),
        empRecs.length > 0 ? parseFloat((totalHours/empRecs.length).toFixed(1)) : 0,
        statusText
      ]);
    }

    const sortedAtt = attendance.sort((a,b) => a.date.localeCompare(b.date));
    const dailyRows = sortedAtt.map(rec => [
      rec.date, rec.userId?.employeeId||'N/A', rec.userId?.name||'N/A',
      rec.userId?.department||'N/A',
      rec.loginTime  ? new Date(rec.loginTime).toLocaleTimeString()  : '-',
      rec.logoutTime ? new Date(rec.logoutTime).toLocaleTimeString() : '-',
      rec.totalHours||0, rec.status, rec.notes||''
    ]);

    const editRows = sortedAtt.map(rec => [
      rec.userId?.employeeId||'', rec.userId?.name||'', rec.date,
      rec.loginTime  ? `${String(new Date(rec.loginTime).getHours()).padStart(2,'0')}:${String(new Date(rec.loginTime).getMinutes()).padStart(2,'0')}`  : '',
      rec.logoutTime ? `${String(new Date(rec.logoutTime).getHours()).padStart(2,'0')}:${String(new Date(rec.logoutTime).getMinutes()).padStart(2,'0')}` : '',
      rec.totalHours||0, rec.status, rec.notes||''
    ]);

    const { spreadsheetUrl } = await createGoogleSheet(
      `FaceAttend - ${monthName} ${y}`,
      [],
      [
        {
          sheetTitle: 'Monthly Summary',
          sheetHeaders: ['Emp ID','Name','Department','Total Days','Present','Absent','Late','Half Day','Total Hours','Avg Hours/Day','Status'],
          sheetRows: summaryRows
        },
        {
          sheetTitle: 'Daily Detail',
          sheetHeaders: ['Date','Emp ID','Name','Department','Login Time','Logout Time','Hours','Status','Notes'],
          sheetRows: dailyRows
        },
        {
          sheetTitle: 'Editable Template',
          sheetHeaders: ['Emp ID','Name','Date','Login (HH:MM)','Logout (HH:MM)','Total Hours','Status','Notes'],
          sheetRows: editRows
        },
      ],
      serviceAccountKey
    );

    res.json({ success: true, url: spreadsheetUrl, monthName, year: y });
  } catch (error) {
    console.error('[google-sheet] error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/export/employee/:id
router.get('/employee/:id', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user._id.toString() !== req.params.id) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const { month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year)  || new Date().getFullYear();
    const monthName = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long' });

    const emp = await User.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay   = new Date(y, m, 0).getDate();
    const endDate   = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

    const records = await Attendance.find({
      userId: req.params.id,
      date: { $gte: startDate, $lte: endDate }
    }).sort({ date: 1 });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`${emp.name} - ${monthName}`);
    sheet.mergeCells('A1:F1');
    sheet.getCell('A1').value = `${emp.name} (${emp.employeeId}) - ${monthName} ${y}`;
    sheet.getCell('A1').font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    sheet.getCell('A1').fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 35;

    sheet.addRow(['Date','Login Time','Logout Time','Total Hours','Status','Notes']);
    sheet.getRow(2).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      c.alignment = { horizontal: 'center' };
    });
    records.forEach(rec => {
      sheet.addRow([
        rec.date,
        rec.loginTime  ? new Date(rec.loginTime).toLocaleTimeString()  : '-',
        rec.logoutTime ? new Date(rec.logoutTime).toLocaleTimeString() : '-',
        rec.totalHours||0, rec.status, rec.notes||''
      ]);
    });
    sheet.columns = [{width:14},{width:14},{width:14},{width:12},{width:12},{width:24}];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${emp.employeeId}_${monthName}_${y}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
