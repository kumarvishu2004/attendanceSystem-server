/**
 * Seed script - creates admin and demo employee accounts
 * Run: node seed.js
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://vishu1510:admin1510@attendancecluster.4f4iduk.mongodb.net/?appName=AttendanceCluster';

const userSchema = new mongoose.Schema({
  name: String, employeeId: String, email: String,
  password: String, faceDescriptor: [Number],
  faceRegistered: { type: Boolean, default: false },
  role: { type: String, default: 'employee' },
  department: String, isActive: { type: Boolean, default: true }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const seed = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  // Clear existing
  await User.deleteMany({});
  console.log('Cleared existing users');

  const password = await bcrypt.hash('admin123', 12);
  const empPassword = await bcrypt.hash('emp123', 12);

  const users = [
    {
      name: 'System Admin',
      employeeId: 'ADMIN001',
      email: 'admin@company.com',
      password,
      role: 'admin',
      department: 'Management',
      faceRegistered: false
    },
    {
      name: 'John Doe',
      employeeId: 'EMP001',
      email: 'emp@company.com',
      password: empPassword,
      role: 'employee',
      department: 'Engineering',
      faceRegistered: false
    },
    {
      name: 'Jane Smith',
      employeeId: 'EMP002',
      email: 'jane@company.com',
      password: empPassword,
      role: 'employee',
      department: 'Design',
      faceRegistered: false
    },
    {
      name: 'Bob Johnson',
      employeeId: 'EMP003',
      email: 'bob@company.com',
      password: empPassword,
      role: 'employee',
      department: 'Marketing',
      faceRegistered: false
    }
  ];

  await User.insertMany(users);
  console.log('✅ Seed data inserted:');
  console.log('   Admin: admin@company.com / admin123');
  console.log('   Employee: emp@company.com / emp123');
  console.log('   Employee: jane@company.com / emp123');
  console.log('   Employee: bob@company.com / emp123');

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
