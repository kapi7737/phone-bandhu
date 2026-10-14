const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const http = require('http'); 
const { Server } = require('socket.io'); 
const nodemailer = require('nodemailer'); 
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
let mongoConnectionError = null;
app.disable('x-powered-by');

const allowedOrigins = new Set([
    'http://localhost:5500', 'http://127.0.0.1:5500',
    'http://localhost:5200', 'http://127.0.0.1:5200',
    ...(process.env.APP_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]);
const configuredSessionSecret = String(process.env.SESSION_SECRET || '').trim();
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(configuredSessionSecret) < 32) {
    throw new Error('Production requires SESSION_SECRET with at least 32 bytes.');
}
const publicSessionKey = configuredSessionSecret ? Buffer.from(configuredSessionSecret) : crypto.randomBytes(32);
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const requestBuckets = new Map();

function requestLimiter({ limit, windowMs, keyPrefix }) {
    return (req, res, next) => {
        const now = Date.now();
        const key = `${keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
        let bucket = requestBuckets.get(key);
        if (!bucket || bucket.expiresAt <= now) bucket = { count: 0, expiresAt: now + windowMs };
        bucket.count += 1;
        requestBuckets.set(key, bucket);
        if (requestBuckets.size > 5000) {
            for (const [entryKey, entry] of requestBuckets) if (entry.expiresAt <= now) requestBuckets.delete(entryKey);
        }
        res.setHeader('RateLimit-Limit', String(limit));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
        if (bucket.count > limit) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
            return res.status(429).json({ message: 'Too many requests. Please wait and try again.' });
        }
        next();
    };
}

const authLimiter = requestLimiter({ limit: 10, windowMs: 15 * 60 * 1000, keyPrefix: 'auth' });
const adminLoginLimiter = requestLimiter({ limit: 5, windowMs: 15 * 60 * 1000, keyPrefix: 'admin-login' });
const sensitiveWriteLimiter = requestLimiter({ limit: 30, windowMs: 60 * 1000, keyPrefix: 'sensitive-write' });

function signSession(subject, kind, version = '') {
    const payload = Buffer.from(JSON.stringify({ sub: String(subject), kind, ver: version, exp: Date.now() + SESSION_MAX_AGE_MS })).toString('base64url');
    const signature = crypto.createHmac('sha256', publicSessionKey).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function readSession(req, cookieName, expectedKind) {
    const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
        const separator = part.indexOf('=');
        return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }));
    const token = cookies[cookieName];
    if (!token) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', publicSessionKey).update(payload).digest();
    let provided;
    try { provided = Buffer.from(signature, 'base64url'); } catch { return null; }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return claims.kind === expectedKind && typeof claims.sub === 'string' && claims.exp > Date.now() ? claims : null;
    } catch { return null; }
}

function setSessionCookie(req, res, name, subject, kind, version = '') {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(name, signSession(subject, kind, version), { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: SESSION_MAX_AGE_MS });
}

function clearSessionCookie(req, res, name) {
    res.clearCookie(name, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
}

async function requireUser(req, res, next) {
    const session = readSession(req, 'pb_session', 'user');
    if (!session || !mongoose.isValidObjectId(session.sub)) return res.status(401).json({ message: 'Please sign in to continue.' });
    try {
        const user = await User.findById(session.sub).select('name email phone phoneBandhuId sessionVersion');
        if (!user || !user.sessionVersion || user.sessionVersion !== session.ver) return res.status(401).json({ message: 'Please sign in to continue.' });
        res.setHeader('Cache-Control', 'no-store');
        req.authUser = user;
        next();
    } catch { res.status(503).json({ message: 'Could not verify your session. Please retry.' }); }
}

async function requireAdmin(req, res, next) {
    const session = readSession(req, 'pb_admin_session', 'admin');
    if (!session) return res.status(401).json({ message: 'Administrator sign-in is required.' });
    try {
        const masterEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
        const masterHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
        if (masterEmail && masterHash && session.sub === masterEmail) {
            const version = crypto.createHash('sha256').update(masterHash).digest('hex');
            if (session.ver !== version) return res.status(401).json({ message: 'Administrator sign-in is required.' });
            req.adminEmail = masterEmail;
            req.adminRole = 'master';
            req.adminId = 'master';
        } else {
            const admin = await Admin.findOne({ email: session.sub, status: 'approved' }).select('email +passwordHash status');
            if (!admin || session.ver !== crypto.createHash('sha256').update(admin.passwordHash).digest('hex')) return res.status(401).json({ message: 'Administrator sign-in is required.' });
            req.adminEmail = admin.email;
            req.adminRole = 'admin';
            req.adminId = String(admin._id);
        }
        res.setHeader('Cache-Control', 'no-store');
        next();
    } catch { res.status(503).json({ message: 'Could not verify your administrator session.' }); }
}

const securityHeaders = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://cdn.socket.io; connect-src 'self' http://localhost:5200 http://127.0.0.1:5200 ws://localhost:5200 ws://127.0.0.1:5200 https://api.razorpay.com https://checkout.razorpay.com; frame-src https://*.razorpay.com");
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
};

// Middleware - Handling image data parsing buffer limits securely
app.use(securityHeaders);
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error('Origin is not allowed by PhoneBandhu API.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '10mb' })); 
// Serve the PhoneBandhu storefront from the backend origin as well as its API.
const storefrontPath = path.resolve(__dirname, '..');
app.use(['/backend', '/node_modules', '/package.json', '/package-lock.json'], (req, res) => res.sendStatus(404));
app.use(express.static(storefrontPath));

app.get('/api/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const detail = String(mongoConnectionError || '');
    const databaseIssue = mongoose.connection.readyState === 1 ? null : /querySrv|ENOTFOUND/i.test(detail) ? 'dns' : /Authentication failed|bad auth/i.test(detail) ? 'auth' : /whitelist|not allowed/i.test(detail) ? 'network-access' : detail ? 'unavailable' : null;
    const databaseError = databaseIssue === 'dns' ? 'Database DNS lookup failed.' : databaseIssue === 'auth' ? 'Database rejected the configured database user.' : databaseIssue === 'network-access' ? 'Database provider rejected this server network.' : databaseIssue ? 'Database connection failed; the server will retry.' : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'PhoneBandhu API', database: states[mongoose.connection.readyState] || 'unknown', databaseIssue, databaseError });
});

// Do not let Mongoose buffer catalog/admin requests while Atlas is offline.
app.use('/api', (req, res, next) => {
    if (req.path === '/health' || mongoose.connection.readyState === 1) return next();
    res.status(503).json({ message: 'Database is unavailable. Check the MongoDB connection and try again.' });
});

// Express Server instance HTTP mapping wrapper 
const server = http.createServer(app);

// Live Socket.io engine core initialize with wide CORS properties 
const io = new Server(server, {
    cors: {
        origin: [...allowedOrigins],
        credentials: true,
        methods: ["GET", "POST"]
    }
});

// Database credentials belong in backend/.env and are never stored in source code.
const MONGO_URI = (process.env.MONGO_URI || '').trim();
async function connectMongoDB() {
    if (!MONGO_URI) {
        mongoConnectionError = 'MONGO_URI is missing. Add it to backend/.env, then restart the server.';
        console.error(mongoConnectionError);
        return;
    }
    try {
        await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        mongoConnectionError = null;
        console.log('Phone Bandhu Database Connected Successfully!');
    } catch (err) {
        const message = String(err.message || 'Database connection failed').replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, 'mongodb+srv://[credentials-redacted]@').slice(0, 320);
        mongoConnectionError = `${err.name || 'MongoDBError'}: ${message}`;
        console.error('MongoDB connection failed; retrying in 10 seconds:', mongoConnectionError);
        setTimeout(connectMongoDB, 10000);
    }
}
connectMongoDB();

// Database Schema Blueprint (Refurbished Device Catalog)
const phoneSchema = new mongoose.Schema({
    brand: { type: String, required: true },
    model: { type: String, required: true },
    price: { type: Number, required: true },
    location: { type: String, required: true },
    condition: { type: String, required: true }, 
    image: { type: String, default: "" },
    images: { type: [String], default: [] },
    issues: {
        screenBroken: { type: Boolean, default: false },
        displayTouchIssue: { type: Boolean, default: false },
        bodyDents: { type: Boolean, default: false },
        waterDamage: { type: Boolean, default: false },
        batteryLow: { type: Boolean, default: false },
        chargingIssue: { type: Boolean, default: false },
        cameraIssue: { type: Boolean, default: false },
        audioIssue: { type: Boolean, default: false },
        buttonOrNetworkIssue: { type: Boolean, default: false },
        biometricIssue: { type: Boolean, default: false },
        repairedOrNonOriginalParts: { type: Boolean, default: false },
        missingBillBox: { type: Boolean, default: false },
        outOfWarranty: { type: Boolean, default: false }
    },
    createdAt: { type: Date, default: Date.now }
}, { strict: false });

const Phone = mongoose.model('Phone', phoneSchema);

// Customer Accounts Registration Structure Blueprint
const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    phoneBandhuId: { type: String, unique: true, sparse: true },
    password: { type: String, required: true }, 
    passwordResetTokenHash: { type: String, default: '' },
    passwordResetExpires: { type: Date, default: null },
    sessionVersion: { type: String, default: () => crypto.randomBytes(16).toString('hex') },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const dummyPasswordHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

const adminAccountSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'disabled'], default: 'pending', index: true },
    createdBy: { type: String, required: true },
    approvedBy: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});
const Admin = mongoose.model('Admin', adminAccountSchema);

const adminAuditSchema = new mongoose.Schema({
    actorEmail: { type: String, required: true, index: true },
    actorRole: { type: String, enum: ['master', 'admin', 'customer'], required: true },
    action: { type: String, required: true, index: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, index: true }
});
const AdminAudit = mongoose.model('AdminAudit', adminAuditSchema);

async function recordAdminAction(req, action, targetType, targetId = '', details = {}) {
    try {
        await AdminAudit.create({
            actorEmail: req.adminEmail,
            actorRole: req.adminRole,
            action,
            targetType,
            targetId: String(targetId || ''),
            details,
            ip: String(req.ip || '').slice(0, 100),
            userAgent: String(req.get('user-agent') || '').slice(0, 300)
        });
    } catch (error) {
        console.error('Admin audit record could not be written:', error.message);
        throw new Error('The action was not completed because its audit record could not be saved. Please retry.');
    }
}

function requireMasterAdmin(req, res, next) {
    if (req.adminRole !== 'master') return res.status(403).json({ message: 'Only the master administrator can manage admin accounts and audit logs.' });
    next();
}

app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    const configuredEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const configuredHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ message: 'Enter a valid administrator email and password.' });
    try {
        let passwordHash = '';
        if (configuredEmail && configuredHash && email === configuredEmail) passwordHash = configuredHash;
        else {
            const admin = await Admin.findOne({ email, status: 'approved' }).select('+passwordHash email');
            passwordHash = admin?.passwordHash || '';
        }
        const matches = await bcrypt.compare(password, passwordHash || dummyPasswordHash).catch(() => false);
        if (!passwordHash || !matches) return res.status(401).json({ message: 'Administrator email or password is incorrect, or this admin is not approved.' });
        const passwordVersion = crypto.createHash('sha256').update(passwordHash).digest('hex');
        setSessionCookie(req, res, 'pb_admin_session', email, 'admin', passwordVersion);
        res.json({ message: 'Administrator signed in.' });
    } catch (err) {
        console.error('Admin authentication failed:', err.message);
        res.status(500).json({ message: 'Could not sign in right now.' });
    }
});

app.get('/api/admin/session', requireAdmin, (req, res) => res.json({ authenticated: true, email: req.adminEmail, role: req.adminRole }));
app.post('/api/admin/logout', (req, res) => {
    clearSessionCookie(req, res, 'pb_admin_session');
    res.json({ message: 'Administrator signed out.' });
});

app.get('/api/admin/admins', requireAdmin, requireMasterAdmin, async (req, res) => {
    try {
        const masterEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
        const admins = await Admin.find({ email: { $ne: masterEmail } }).select('email status createdBy approvedBy approvedAt createdAt').sort({ createdAt: -1 }).limit(500);
        res.json(admins);
    } catch { res.status(500).json({ message: 'Could not load administrator accounts.' }); }
});

app.post('/api/admin/admins', requireAdmin, requireMasterAdmin, sensitiveWriteLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;
    const masterEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || email === masterEmail) return res.status(400).json({ message: 'Enter a valid, distinct administrator email.' });
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ message: 'Admin password must be at least 12 characters and at most 72 UTF-8 bytes.' });
    try {
        const passwordHash = await bcrypt.hash(password, 12);
        if (await Admin.exists({ email })) return res.status(409).json({ message: 'An admin account already exists for this email.' });
        const admin = await Admin.create({ email, passwordHash, status: 'pending', createdBy: req.adminEmail });
        await recordAdminAction(req, 'admin.created.pending', 'admin', admin._id, { email });
        res.status(201).json({ message: 'Admin created and waiting for master approval.', admin: { _id: admin._id, email: admin.email, status: admin.status, createdAt: admin.createdAt } });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ message: 'An admin account already exists for this email.' });
        res.status(500).json({ message: error.message || 'Could not create admin account.' });
    }
});

app.patch('/api/admin/admins/:id/status', requireAdmin, requireMasterAdmin, sensitiveWriteLimiter, async (req, res) => {
    const status = req.body.status;
    if (!['approved', 'rejected', 'disabled'].includes(status)) return res.status(400).json({ message: 'Choose approve, reject, or disable.' });
    try {
        const admin = await Admin.findById(req.params.id);
        if (!admin) return res.status(404).json({ message: 'Admin account not found.' });
        const previousStatus = admin.status;
        admin.status = status;
        if (status === 'approved') { admin.approvedBy = req.adminEmail; admin.approvedAt = new Date(); }
        await admin.save();
        await recordAdminAction(req, `admin.${status}`, 'admin', admin._id, { email: admin.email, previousStatus, status });
        res.json({ message: `Admin account ${status}.`, admin: { _id: admin._id, email: admin.email, status: admin.status } });
    } catch (error) { res.status(500).json({ message: error.message || 'Could not update this admin account.' }); }
});

app.get('/api/admin/audit', requireAdmin, requireMasterAdmin, async (req, res) => {
    try { res.json(await AdminAudit.find().sort({ createdAt: -1 }).limit(500).lean()); }
    catch { res.status(500).json({ message: 'Could not load admin activity.' }); }
});

async function generateUniquePhoneBandhuId() {
    let phoneBandhuId;
    do {
        phoneBandhuId = `PB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    } while (await User.exists({ phoneBandhuId }));
    return phoneBandhuId;
}

async function ensurePhoneBandhuId(user) {
    if (!user.phoneBandhuId) {
        user.phoneBandhuId = await generateUniquePhoneBandhuId();
        await user.save();
    }
    return user.phoneBandhuId;
}

// Live Messages Persistent Data Storage Schema
const chatSchema = new mongoose.Schema({
    roomId: { type: String, required: true },
    sender: { type: String, required: true },
    text: { type: String, required: true },
    time: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const ChatLog = mongoose.model('ChatLog', chatSchema);

const orderSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true },
    product: { type: String, required: true },
    price: { type: String, required: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    customerEmail: { type: String, required: true },
    address: { type: String, required: true },
    pincode: { type: String, required: true },
    paymentMethod: { type: String, default: 'COD' },
    gatewayOrderId: { type: String, default: '' },
    paymentId: { type: String, default: '' },
    status: { type: String, default: 'Order Placed (COD)' },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ==========================================
// 🛣️ CUSTOMER AUTHENTICATION ROUTE ENDPOINTS
// ==========================================

// 1. Account Registration Handler (Sign Up API)
app.post('/api/auth/signup', authLimiter, async (req, res) => {
    const { name, email, phone, password } = req.body;
    try {
        if (![name, email, phone].every(value => typeof value === 'string' && value.trim()) || typeof password !== 'string') return res.status(400).json({ message: 'Name, email, phone, and password are required.' });
        if (name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^[6-9]\d{9}$/.test(phone) || Buffer.byteLength(password, 'utf8') > 72 || password.length < 12) {
            return res.status(400).json({ message: 'Enter a valid email and Indian mobile number. Password must be at least 12 characters.' });
        }
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newUser = new User({ 
            name, 
            email: email.trim().toLowerCase(), 
            phone, 
            phoneBandhuId: await generateUniquePhoneBandhuId(),
            password: hashedPassword 
        });

        const savedUser = await newUser.save();
        res.status(201).json({ message: "User Registered Safely!", user: { id: savedUser._id, name: savedUser.name, phoneBandhuId: savedUser.phoneBandhuId } });
    } catch (err) {
        res.status(400).json({ message: "Email already exists or database query failed!" });
    }
});

// 2. High-Security Hashed Integrity Verification Router (Login API)
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ message: 'Email or password is incorrect.' });

    try {
        const user = await User.findOne({ email: email });
        const passwordMatch = await bcrypt.compare(password, user?.password || dummyPasswordHash);
        if (!user || !passwordMatch) return res.status(401).json({ message: 'Email or password is incorrect.' });

        await ensurePhoneBandhuId(user);
        if (!user.sessionVersion) { user.sessionVersion = crypto.randomBytes(16).toString('hex'); await user.save(); }
        setSessionCookie(req, res, 'pb_session', user._id, 'user', user.sessionVersion);

        res.json({ 
            message: "लॉगिन सफल रहा! 🎉", 
            user: { id: user._id, name: user.name, email: user.email, phone: user.phone, phoneBandhuId: user.phoneBandhuId } 
        });
    } catch (err) {
        console.error("❌ Login Database Query Error:", err);
        res.status(500).json({ message: "सर्वर एरर! कृपया दोबारा प्रयास करें।" });
    }
});

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res, 'pb_session');
    res.json({ message: 'Signed out.' });
});

app.get('/api/account/profile', requireUser, async (req, res) => {
    try {
        const user = await User.findById(req.authUser._id).select('name email phone phoneBandhuId createdAt');
        if (!user) return res.status(404).json({ message: 'Account not found. Please sign in again.' });
        await ensurePhoneBandhuId(user);
        res.json({ id: user._id, name: user.name, email: user.email, phone: user.phone, phoneBandhuId: user.phoneBandhuId, createdAt: user.createdAt });
    } catch (err) {
        res.status(500).json({ message: 'Could not load account profile.' });
    }
});
// 📬 3. पासवर्ड भूल जाने पर (Forgot Password) रीसेट करने का रास्ता
app.post('/api/account/change-password', requireUser, sensitiveWriteLimiter, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 72 || typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        return res.status(400).json({ message: 'Enter your current password and a new password with at least 12 characters.' });
    }
    try {
        const user = await User.findById(req.authUser._id);
        if (!user) return res.status(404).json({ message: 'Account not found. Please sign in again.' });
        if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: 'Current password is incorrect.' });
        if (await bcrypt.compare(newPassword, user.password)) return res.status(400).json({ message: 'Choose a new password different from your current password.' });
        user.password = await bcrypt.hash(newPassword, 10);
        user.passwordResetTokenHash = '';
        user.passwordResetExpires = null;
        user.sessionVersion = crypto.randomBytes(16).toString('hex');
        await user.save();
        clearSessionCookie(req, res, 'pb_session');
        return res.json({ message: 'Password changed successfully.' });
    } catch (err) {
        console.error('Change Password API Error:', err);
        return res.status(500).json({ message: 'Could not change password right now. Please try again.' });
    }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return res.status(503).json({ message: 'Password recovery email is not configured.' });
        const user = await User.findOne({ email });
        if (!user) return res.json({ message: 'If that account exists, a password reset link will be sent.' });
        if (!user) {
            return res.status(404).json({ message: "यह ईमेल आईडी डेटाबेस में रजिस्टर्ड नहीं है!" });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const resetToken = crypto.randomBytes(32).toString('hex');
        user.passwordResetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
        await user.save();
        const publicAppUrl = String(process.env.PUBLIC_APP_URL || 'http://localhost:5200').replace(/\/$/, '');
        const resetLink = `${publicAppUrl}/reset-password.html?email=${encodeURIComponent(user.email)}#token=${encodeURIComponent(resetToken)}`;

        const mailOptions = {
            from: '"PhoneBandhu Support" <no-reply@phonebandhu.com>',
            to: user.email,
            subject: '🔒 Reset Your PhoneBandhu Account Password',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 disorder; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                    <h2 style="color: #022449; text-align: center;">PhoneBandhu Central</h2>
                    <p>Hello <b>${String(user.name).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</b>,</p>
                    <p>We received a request to reset the password for your account. Click the secure button below to choose a new password:</p>
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${resetLink}" style="background-color: #022449; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password Now</a>
                    </div>
                    <p style="color: #64748b; font-size: 0.85rem;">If you did not request this, please ignore this email safely.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);

        res.json({ message: "🔒 पासवर्ड रीसेट लिंक आपके रजिस्टर्ड ईमेल पर सफलतापूर्वक भेज दी गई है!" });

    } catch (err) {
        console.error("Forgot Password System Crash:", err);
        res.status(500).json({ message: "सर्वर एरर! कृपया दोबारा प्रयास करें।" });
    }
});

// 🔒 3.5 नया पासवर्ड डेटाबेस में अपडेट करने का रास्ता (Reset Password Endpoint)
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { newPassword, token } = req.body;
    try {
        if (!email || typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword, 'utf8') > 72 || !token) {
            return res.status(400).json({ message: 'A valid reset link and a password of at least 12 characters are required.' });
        }
        const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
        const user = await User.findOne({ email, passwordResetTokenHash: tokenHash, passwordResetExpires: { $gt: new Date() } });
        if (!user) {
            return res.status(404).json({ message: "यह यूज़र डेटाबेस में नहीं मिला!" });
        }

        // नए पासवर्ड को Bcrypt से सुरक्षित हैश (Encrypt) करना
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // डेटाबेस में नया पासवर्ड इंजेक्ट करना
        user.password = hashedPassword;
        user.passwordResetTokenHash = '';
        user.passwordResetExpires = null;
        user.sessionVersion = crypto.randomBytes(16).toString('hex');
        await user.save();
        clearSessionCookie(req, res, 'pb_session');

        res.json({ message: "🔒 आपका नया पासवर्ड डेटाबेस में सुरक्षित अपडेट हो गया है! अब लॉगिन करें।" });

    } catch (err) {
        console.error("Reset Password API Error:", err);
        res.status(500).json({ message: "सर्वर एरर! पासवर्ड अपडेट नहीं हो पाया।" });
    }
});

// ==========================================
// 🎛️ CENTRAL ADMIN INTERFACE MANAGEMENT ROUTES
// ==========================================

// 4. Fetch Registered User Accounts
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password -passwordResetTokenHash -passwordResetExpires -sessionVersion').sort({ createdAt: -1 }).limit(500);
        for (const user of users) await ensurePhoneBandhuId(user);
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 }).limit(500);
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

app.patch('/api/admin/orders/:id/status', requireAdmin, sensitiveWriteLimiter, async (req, res) => {
    const allowedStatuses = ['Shipped (In Transit)', 'Delivered', 'Cancelled'];
    if (!allowedStatuses.includes(req.body.status)) return res.status(400).json({ message: 'Invalid order status.' });
    try {
        const order = await Order.findOneAndUpdate({ orderId: req.params.id }, { status: req.body.status }, { new: true, runValidators: true });
        if (!order) return res.status(404).json({ message: 'Order not found.' });
        await recordAdminAction(req, 'order.status.updated', 'order', order.orderId, { product: order.product, status: order.status });
        res.json(order);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// 5. Fetch Complete Live Sales Stock Catalog
app.get('/api/phones', async (req, res) => {
    try {
        // Storefront receives only sale stock; seller pickup and contact details stay private.
        const phones = await Phone.find({ status: 'Available' }).sort({ createdAt: -1 }).select('-sellerEmail -sellerName -sellerPhone -sellerPincode -pickupAddress').limit(100);
        res.json(phones);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

app.get('/api/admin/phones', requireAdmin, async (req, res) => {
    try {
        const phones = await Phone.find().sort({ createdAt: -1 }).limit(500);
        res.json(phones);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// Admin catalog entries are separate from customer buyback submissions.
app.post('/api/admin/phones', requireAdmin, sensitiveWriteLimiter, async (req, res) => {
    try {
        const { brand, model, price, location, condition, images } = req.body;
        if (![brand, model, location, condition].every(value => String(value || '').trim()) || !Number.isFinite(Number(price)) || Number(price) <= 0) {
            return res.status(400).json({ message: 'Brand, model, price, location, and condition are required.' });
        }
        const imageList = Array.isArray(images) ? images.slice(0, 6) : [];
        if (imageList.some(value => typeof value !== 'string' || value.length > 1500000 || !/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(value))) return res.status(400).json({ message: 'Phone photos must be JPG, PNG, or WebP images, each no larger than 1 MB.' });
        const phone = await new Phone({ brand: brand.trim(), model: model.trim(), price: Number(price), location: location.trim(), condition: condition.trim(), images: imageList, image: imageList[0] || '', status: 'Available' }).save();
        await recordAdminAction(req, 'inventory.phone.created', 'phone', phone._id, { brand: phone.brand, model: phone.model, price: phone.price });
        res.status(201).json(phone);
    } catch (err) {
        res.status(400).json({ message: 'Could not process the request. Check the submitted details and try again.' });
    }
});

app.get('/api/account/buybacks', requireUser, async (req, res) => {
    try {
        const requests = await Phone.find({ sellerEmail: req.authUser.email }).select('brand model price offerPrice location condition storage age status createdAt offerSentAt offerRespondedAt').sort({ createdAt: -1 }).limit(100).lean();
        res.setHeader('Cache-Control', 'no-store');
        res.json(requests);
    } catch { res.status(500).json({ message: 'Could not load your buyback requests.' }); }
});

app.patch('/api/account/buybacks/:id/decision', requireUser, sensitiveWriteLimiter, async (req, res) => {
    const decision = req.body.decision;
    if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ message: 'Choose accept or decline.' });
    try {
        const request = await Phone.findOne({ _id: req.params.id, sellerEmail: req.authUser.email, status: 'Offer Awaiting Seller' });
        if (!request) return res.status(404).json({ message: 'No pending offer was found for your account.' });
        request.status = decision === 'accept' ? 'Offer Accepted' : 'Offer Declined';
        request.offerRespondedAt = new Date();
        await request.save();
        await AdminAudit.create({ actorEmail: req.authUser.email, actorRole: 'customer', action: `buyback.offer.${decision === 'accept' ? 'accepted' : 'declined'}`, targetType: 'phone', targetId: String(request._id), details: { brand: request.brand, model: request.model, offerPrice: request.offerPrice } });
        res.json({ message: decision === 'accept' ? 'Offer accepted. PhoneBandhu will contact you to arrange pickup.' : 'Offer declined. No pickup will be arranged.', status: request.status });
    } catch { res.status(500).json({ message: 'Could not save your offer decision.' }); }
});

// 6. Submit Buyback Requests
app.post('/api/phones', requireUser, sensitiveWriteLimiter, async (req, res) => {
    try {
        const { brand, model, price, location, condition, images, sellerName, sellerPhone, sellerPincode, pickupAddress, age, storage, issues } = req.body;
        if (![brand, model, location, condition, sellerName, sellerPhone, sellerPincode, pickupAddress, storage].every(value => String(value || '').trim())) {
            return res.status(400).json({ message: 'Phone, seller contact, and pickup address details are required.' });
        }
        if (!Number.isFinite(Number(price)) || Number(price) < 0 || !/^[6-9]\d{9}$/.test(String(sellerPhone)) || !/^[1-9]\d{5}$/.test(String(sellerPincode))) {
            return res.status(400).json({ message: 'Enter a valid estimate or manual valuation, 10-digit mobile number, and 6-digit Indian PIN code.' });
        }
        const imageList = Array.isArray(images) ? images.slice(0, 6) : [];
        if (imageList.some(value => typeof value !== 'string' || value.length > 1500000 || !/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(value))) return res.status(400).json({ message: 'Phone photos must be JPG, PNG, or WebP images, each no larger than 1 MB.' });
        if (!imageList.length) return res.status(400).json({ message: 'At least one phone photo is required.' });
        const newPhone = new Phone({
            brand: brand.trim(),
            model: model.trim(),
            price: Number(price),
            location: location.trim(),
            condition: condition.trim(),
            image: imageList[0],
            images: imageList,
            issues: issues || {},
            sellerEmail: req.authUser.email,
            sellerName: sellerName.trim(),
            sellerPhone: String(sellerPhone),
            sellerPincode: String(sellerPincode),
            pickupAddress: pickupAddress.trim(),
            age,
            storage,
            status: 'Pending Valuation Approval'
        });
        const savedPhone = await newPhone.save();
        res.status(201).json(savedPhone);
    } catch (err) {
        res.status(400).json({ message: 'Could not process the request. Check the submitted details and try again.' });
    }
});

// Buyback workflow: request -> inspection -> seller offer -> accepted -> received and paid -> published.
app.patch('/api/admin/phones/:id/buyback', requireAdmin, sensitiveWriteLimiter, async (req, res) => {
    const action = req.body.action;
    try {
        const phone = await Phone.findOne({ _id: req.params.id, sellerPhone: { $exists: true, $ne: '' } });
        if (!phone) return res.status(404).json({ message: 'Buyback request not found.' });
        const previousStatus = phone.status;
        if (action === 'start_inspection' && phone.status === 'Pending Valuation Approval') {
            phone.status = 'Inspection In Progress';
        } else if (action === 'send_offer' && phone.status === 'Inspection In Progress') {
            const offerPrice = Number(req.body.price);
            if (!Number.isFinite(offerPrice) || offerPrice <= 0 || offerPrice > 1000000) return res.status(400).json({ message: 'Enter a final offer between ₹1 and ₹10,00,000.' });
            phone.offerPrice = offerPrice;
            phone.offerSentAt = new Date();
            phone.status = 'Offer Awaiting Seller';
        } else if (action === 'confirm_received_paid' && phone.status === 'Offer Accepted') {
            phone.price = Number(phone.offerPrice);
            phone.status = 'Available';
        } else {
            return res.status(409).json({ message: 'This action is not available at the current buyback stage.' });
        }
        await phone.save();
        await recordAdminAction(req, `buyback.${action}`, 'phone', phone._id, { brand: phone.brand, model: phone.model, previousStatus, status: phone.status, price: phone.offerPrice || phone.price, sellerEmail: phone.sellerEmail || '' });
        res.json({ message: phone.status === 'Available' ? 'Phone received and paid; listing is now live.' : 'Buyback status updated.', phone });
    } catch (err) {
        res.status(500).json({ message: 'Could not approve this buyback request.' });
    }
});

// 7. Delete Phone Listings

app.delete('/api/admin/phones/:id', requireAdmin, sensitiveWriteLimiter, async (req, res) => {
    try {
        const deletedPhone = await Phone.findByIdAndDelete(req.params.id);
        if (!deletedPhone) return res.status(404).json({ message: "Phone listing not found" });
        await recordAdminAction(req, 'inventory.phone.deleted', 'phone', deletedPhone._id, { brand: deletedPhone.brand, model: deletedPhone.model, sellerEmail: deletedPhone.sellerEmail || '' });
        res.json({ message: "Phone listing deleted successfully!" });
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// 8. Remove User Profiles
app.delete('/api/admin/users/:id', requireAdmin, sensitiveWriteLimiter, async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id);
        if (!deletedUser) return res.status(404).json({ message: "User not found" });
        await recordAdminAction(req, 'customer.deleted', 'user', deletedUser._id, { email: deletedUser.email });
        res.json({ message: "User removed from database successfully!" });
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// 9. Customer orders and Razorpay online checkout
app.get('/api/payments/config', (req, res) => {
    res.json({ onlineEnabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) });
});

app.post('/api/payments/create-order', requireUser, sensitiveWriteLimiter, async (req, res) => {
    const { productId, customerName, customerPhone, address, pincode } = req.body;
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return res.status(503).json({ message: 'Online payments are not configured yet. Please use cash on delivery.' });
    }
    if (![customerName, customerPhone, address, pincode, productId].every(value => String(value || '').trim())) {
        return res.status(400).json({ message: 'Please complete all delivery details.' });
    }
    try {
        if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ message: 'This item is not available for online checkout.' });
        const phone = await Phone.findOne({ _id: productId, status: 'Available' });
        if (!phone || !Number.isFinite(Number(phone.price)) || Number(phone.price) <= 0) return res.status(404).json({ message: 'This phone is no longer available.' });
        const orderId = `PB-ORD-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
        const amount = Math.round(Number(phone.price) * 100);
        const gatewayResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: { 'Authorization': `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, currency: 'INR', receipt: orderId })
        });
        const gatewayOrder = await gatewayResponse.json();
        if (!gatewayResponse.ok) return res.status(502).json({ message: gatewayOrder.error?.description || 'Payment provider could not start checkout.' });
        await new Order({ orderId, product: phone.model, price: `₹${Number(phone.price).toLocaleString('en-IN')}`, customerName, customerPhone, customerEmail: req.authUser.email, address, pincode, paymentMethod: 'Razorpay', gatewayOrderId: gatewayOrder.id, status: 'Payment Pending' }).save();
        res.status(201).json({ keyId: process.env.RAZORPAY_KEY_ID, gatewayOrderId: gatewayOrder.id, amount, currency: 'INR', orderId });
    } catch (err) {
        console.error('Razorpay order creation failed:', err);
        res.status(500).json({ message: 'Could not start payment. Please try again.' });
    }
});

app.post('/api/payments/verify', requireUser, async (req, res) => {
    const { internalOrderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({ message: 'Payment verification is not configured.' });
    try {
        const order = await Order.findOne({ orderId: internalOrderId, gatewayOrderId: razorpay_order_id, customerEmail: req.authUser.email });
        if (!order) return res.status(404).json({ message: 'Payment order not found.' });
        const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
        const expectedBuffer = Buffer.from(expected);
        const receivedBuffer = Buffer.from(String(razorpay_signature || ''));
        if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return res.status(400).json({ message: 'Payment signature could not be verified.' });
        if (order.status !== 'Payment Successful') {
            order.paymentId = razorpay_payment_id;
            order.status = 'Payment Successful';
            await order.save();
        }
        res.json({ orderId: order.orderId, status: order.status });
    } catch (err) {
        console.error('Payment verification failed:', err);
        res.status(500).json({ message: 'Could not verify payment. Contact support with your payment reference.' });
    }
});

// COD orders
app.post('/api/orders', requireUser, sensitiveWriteLimiter, async (req, res) => {
    let reservedPhones = [];
    try {
        const { productId, productIds, customerName, customerPhone, address, pincode } = req.body;
        const requestedIds = Array.isArray(productIds) ? [...new Set(productIds.map(String))] : [String(productId || '')];
        if (!requestedIds.length || requestedIds.length > 8 || ![customerName, customerPhone, address, pincode].every(value => String(value || '').trim()) || !/^[6-9]\d{9}$/.test(String(customerPhone)) || !/^[1-9]\d{5}$/.test(String(pincode))) {
            return res.status(400).json({ message: 'Please complete all delivery details and limit your cart to 8 phones.' });
        }
        if (!requestedIds.every(id => mongoose.isValidObjectId(id))) return res.status(400).json({ message: 'A cart item is invalid. Remove it and try again.' });
        for (const id of requestedIds) {
            const phone = await Phone.findOneAndUpdate({ _id: id, status: 'Available' }, { $set: { status: 'Sold' } }, { new: true });
            if (!phone) {
                await Phone.updateMany({ _id: { $in: reservedPhones.map(item => item._id) }, status: 'Sold' }, { $set: { status: 'Available' } });
                return res.status(409).json({ message: 'One of these phones was just sold. Refresh your cart and try again.' });
            }
            reservedPhones.push(phone);
        }
        const currency = String.fromCharCode(8377);
        const orders = await Order.insertMany(reservedPhones.map(phone => ({ orderId: `PB-ORD-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, product: phone.model, price: `${currency}${Number(phone.price).toLocaleString('en-IN')}`, customerName, customerPhone, customerEmail: req.authUser.email, address, pincode, paymentMethod: 'COD', status: 'Order Placed (COD)' })));
        res.status(201).json({ orders, orderIds: orders.map(order => order.orderId), orderId: orders[0]?.orderId });
    } catch (err) {
        if (reservedPhones.length) await Phone.updateMany({ _id: { $in: reservedPhones.map(item => item._id) }, status: 'Sold' }, { $set: { status: 'Available' } }).catch(() => {});
        res.status(400).json({ message: 'Could not process the request. Check the submitted details and try again.' });
    }
});

app.get('/api/orders', requireUser, async (req, res) => {
    try {
        const orders = await Order.find({ customerEmail: req.authUser.email }).sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// 10. Chat Thread Reload History API
app.get('/api/chats/:roomId', requireUser, async (req, res) => {
    try {
        const history = await ChatLog.find({ roomId: `support:${req.authUser._id}` }).sort({ timestamp: 1 }).limit(200);
        res.json(history);
    } catch (err) {
        res.status(500).json({ message: 'Could not complete this request right now. Please try again.' });
    }
});

// ==========================================
// ⚡ SOCKET.IO DYNAMIC NETWORK BROADCASTING PIPES
// ==========================================
io.use(async (socket, next) => {
    const session = readSession(socket.handshake, 'pb_session', 'user');
    if (!session || !mongoose.isValidObjectId(session.sub)) return next(new Error('Authentication required.'));
    try {
        const user = await User.findById(session.sub).select('name sessionVersion');
        if (!user || !user.sessionVersion || user.sessionVersion !== session.ver) return next(new Error('Authentication required.'));
        socket.data.authUser = user;
        next();
    } catch { next(new Error('Authentication required.')); }
});

io.on('connection', (socket) => {
    console.log(`⚡ Live User Connected via WebSockets: ${socket.id}`);

    socket.on('join_room', async () => {
        socket.join(`support:${socket.data.authUser._id}`);
    });

    socket.on('send_live_message', async (data) => {
        const roomId = `support:${socket.data.authUser._id}`;
        const text = String(data?.text || '').trim();
        if (!socket.rooms.has(roomId) || !text || text.length > 2000) return;
        const now = Date.now();
        if (!socket.data.messageWindow || now - socket.data.messageWindow.startedAt >= 60000) socket.data.messageWindow = { startedAt: now, count: 0 };
        socket.data.messageWindow.count += 1;
        if (socket.data.messageWindow.count > 20) return;
        try {
            const logEntry = new ChatLog({ roomId, sender: socket.data.authUser.name, text, time: new Date().toISOString() });
            await logEntry.save();
            io.to(roomId).emit('receive_live_message', { roomId, sender: socket.data.authUser.name, text, time: logEntry.time });
        } catch(dbErr) {
            console.error("Error storing web socket packets to database:", dbErr);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Live Connection Channel disconnected: ${socket.id}`);
    });
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const originRejected = String(err.message || '').includes('Origin is not allowed');
    const bodyRejected = ['entity.too.large', 'entity.parse.failed'].includes(err.type);
    const status = originRejected ? 403 : bodyRejected ? (err.type === 'entity.too.large' ? 413 : 400) : 500;
    if (status === 500) console.error('Unhandled API error:', err.name || 'Error');
    res.status(status).json({ message: originRejected ? 'This website origin is not allowed.' : bodyRejected ? 'Request body is invalid or too large.' : 'The server could not complete this request.' });
});

// Initialize environment listeners
const PORT = process.env.PORT || 5200;
server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
            const health = await response.json();
            if (health.service === 'PhoneBandhu API') {
                console.log(`PhoneBandhu backend is already running on port ${PORT}; use the existing instance.`);
                process.exit(0);
            }
        } catch {}
        console.error(`Port ${PORT} is already in use by another application. Set a free PORT in backend/.env and point the website to that port.`);
        process.exit(1);
    }
    console.error('PhoneBandhu server error:', err.message);
    process.exit(1);
});
server.listen(PORT, () => console.log(`🚀 Hybrid Real-time Server running on port ${PORT}`));
