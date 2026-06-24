const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect, adminOnly } = require('../middleware/auth');

// @route PUT /api/users/register-face
// @desc Register face descriptor for current user
router.put('/register-face', protect, async (req, res) => {
  try {
    const { faceDescriptor, profileImage } = req.body;

    if (!faceDescriptor || !Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
      return res.status(400).json({ success: false, message: 'Invalid face descriptor. Must be a 128-element array.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { faceDescriptor, faceRegistered: true, profileImage: profileImage || null },
      { new: true }
    );

    res.json({ success: true, message: 'Face registered successfully', user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route POST /api/users/recognize-face
// @desc Match face descriptor against all registered users
router.post('/recognize-face', async (req, res) => {
  try {
    const { faceDescriptor } = req.body;

    if (!faceDescriptor || !Array.isArray(faceDescriptor)) {
      return res.status(400).json({ success: false, message: 'Face descriptor required' });
    }

    // Get all users with registered faces
    const users = await User.find({ faceRegistered: true, isActive: true });

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'No registered faces found' });
    }

    const MATCH_THRESHOLD = 0.5; // Lower = stricter matching
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const user of users) {
      if (!user.faceDescriptor || user.faceDescriptor.length !== 128) continue;

      // Euclidean distance between descriptors
      const distance = euclideanDistance(faceDescriptor, user.faceDescriptor);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestMatch = user;
      }
    }

    if (bestMatch && bestDistance < MATCH_THRESHOLD) {
      return res.json({
        success: true,
        matched: true,
        user: bestMatch,
        confidence: Math.round((1 - bestDistance) * 100),
        distance: bestDistance
      });
    }

    res.json({ success: true, matched: false, message: 'No matching face found', distance: bestDistance });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/users/profile/:id
// @desc Get user profile
router.get('/profile/:id', protect, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route PUT /api/users/profile
// @desc Update own profile
router.put('/profile', protect, async (req, res) => {
  try {
    const { name, department } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { name, department },
      { new: true, runValidators: true }
    );
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route GET /api/users/all
// @desc Get all users (admin only)
router.get('/all', protect, adminOnly, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, department } = req.query;
    const query = {};
    if (search) query.$or = [
      { name: new RegExp(search, 'i') },
      { employeeId: new RegExp(search, 'i') },
      { email: new RegExp(search, 'i') }
    ];
    if (department) query.department = department;

    const users = await User.find(query)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await User.countDocuments(query);

    res.json({ success: true, users, total, pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route PUT /api/users/:id/toggle-active
// @desc Toggle user active status (admin)
router.put('/:id/toggle-active', protect, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.isActive = !user.isActive;
    await user.save();
    res.json({ success: true, user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Euclidean distance utility
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

module.exports = router;
