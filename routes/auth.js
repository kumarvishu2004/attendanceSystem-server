const express  = require('express');
const router   = express.Router();
const { body, validationResult } = require('express-validator');
const jwt      = require('jsonwebtoken');
const https    = require('https');
const User     = require('../models/User');
const { generateToken, protect } = require('../middleware/auth');

const JWT_SECRET = () => process.env.JWT_SECRET || 'fallback_dev_secret_change_in_production';

// ─── REGISTRATION ─────────────────────────────────────────────────────────────

// Standard registration (single step — no OTP)
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('employeeId').trim().notEmpty().withMessage('Employee ID is required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { name, employeeId, email, password, department, role } = req.body;

    const existing = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { employeeId: employeeId.toUpperCase() }]
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: existing.email === email.toLowerCase()
          ? 'Email already registered'
          : 'Employee ID already exists'
      });
    }

    const user = await User.create({
      name,
      employeeId: employeeId.toUpperCase(),
      email: email.toLowerCase(),
      password,
      department: department || 'General',
      role: role || 'employee',
    });

    const token = generateToken(user._id);
    console.log(`[Register] User created: ${user.email}`);
    res.status(201).json({ success: true, token, user: user.toJSON() });
  } catch (error) {
    console.error('[register] error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

// Standard login (email + password, no OTP)
router.post('/login', [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account deactivated' });
    }

    const token = generateToken(user._id);
    console.log(`[Login] User logged in: ${user.email}`);
    res.json({ success: true, token, user: user.toJSON() });
  } catch (error) {
    console.error('[login] error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────────

// Google sign-in / sign-up using ID token from frontend
router.post('/google', async (req, res) => {
  try {
    const { idToken, employeeId, department } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, message: 'Google ID token required' });
    }

    // Verify Google ID token via Google tokeninfo endpoint
    const googleUser = await verifyGoogleToken(idToken);
    if (!googleUser) {
      return res.status(401).json({ success: false, message: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = googleUser;

    // Find existing user by googleId or email
    let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });

    if (user) {
      // User exists — link Google account if not already linked
      if (!user.googleId) {
        user.googleId = googleId;
        user.googleAvatar = picture || null;
        await user.save();
      }
      if (!user.isActive) {
        return res.status(401).json({ success: false, message: 'Account deactivated' });
      }
    } else {
      // New user — require employeeId for first-time Google sign-up
      if (!employeeId) {
        // Signal that we need additional info to complete registration
        return res.status(200).json({
          success: true,
          needsEmployeeId: true,
          googleData: { googleId, email, name, picture },
          message: 'Please provide your Employee ID to complete registration'
        });
      }

      // Check employeeId not taken
      const empExists = await User.findOne({ employeeId: employeeId.toUpperCase() });
      if (empExists) {
        return res.status(400).json({ success: false, message: 'Employee ID already exists' });
      }

      user = await User.create({
        name,
        email: email.toLowerCase(),
        googleId,
        googleAvatar: picture || null,
        employeeId: employeeId.toUpperCase(),
        department: department || 'General',
        role: 'employee',
      });
      console.log(`[Google] New user created: ${user.email}`);
    }

    const token = generateToken(user._id);
    res.json({ success: true, token, user: user.toJSON() });
  } catch (error) {
    console.error('[google-auth] error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── STANDARD ROUTES ──────────────────────────────────────────────────────────

router.get('/me', protect, async (req, res) => {
  res.json({ success: true, user: req.user });
});

router.put('/change-password', protect, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+password');
    const { currentPassword, newPassword } = req.body;
    if (!user.password) {
      return res.status(400).json({ success: false, message: 'Password change not available for Google accounts' });
    }
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ success: false, message: 'Current password incorrect' });
    }
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`;
    https.get(url, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve(null);
          } else {
            resolve(parsed);
          }
        } catch {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

module.exports = router;

// ─── GOOGLE COMPLETE REGISTRATION ─────────────────────────────────────────────
// Called when a Google new user submits their Employee ID from the register page
router.post('/google-complete', async (req, res) => {
  try {
    const { googleId, email, name, picture, employeeId, department } = req.body;
    if (!googleId || !email || !employeeId) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Double-check user doesn't exist
    const existing = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
    if (existing) {
      // Already exists — just link and log in
      if (!existing.googleId) { existing.googleId = googleId; await existing.save(); }
      const token = generateToken(existing._id);
      return res.json({ success: true, token, user: existing.toJSON() });
    }

    const empExists = await User.findOne({ employeeId: employeeId.toUpperCase() });
    if (empExists) {
      return res.status(400).json({ success: false, message: 'Employee ID already exists' });
    }

    const user = await User.create({
      name, email: email.toLowerCase(), googleId,
      googleAvatar: picture || null,
      employeeId: employeeId.toUpperCase(),
      department: department || 'General',
      role: 'employee',
    });

    const token = generateToken(user._id);
    console.log(`[Google Complete] User created: ${user.email}`);
    res.status(201).json({ success: true, token, user: user.toJSON() });
  } catch (error) {
    console.error('[google-complete] error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
