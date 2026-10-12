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

// Middleware - Handling image data parsing buffer limits securely
app.use(cors());
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ limit: '10mb', extended: true }));
// Serve the PhoneBandhu storefront from the backend origin as well as its API.
const storefrontPath = path.resolve(__dirname, '../phone-bandhu');
app.use(['/node_modules', '/package.json', '/package-lock.json'], (req, res) => res.sendStatus(404));
app.use(express.static(storefrontPath));

app.get('/api/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({ ok: true, service: 'PhoneBandhu API', database: states[mongoose.connection.readyState] || 'unknown', databaseError: mongoose.connection.readyState === 1 ? null : mongoConnectionError });
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
        origin: "*", 
        methods: ["GET", "POST", "DELETE"]
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
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

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
app.post('/api/auth/signup', async (req, res) => {
    const { name, email, phone, password } = req.body;
    try {
        if (![name, email, phone, password].every(value => String(value || '').trim())) return res.status(400).json({ message: 'Name, email, phone, and password are required.' });
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
app.post('/api/auth/login', async (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : "";
    const password = req.body.password;

    try {
        const user = await User.findOne({ email: email });
        if (!user) {
            return res.status(400).json({ message: "गलत ईमेल या पासवर्ड! कृपया सही डिटेल्स डालें।" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "गलत ईमेल या पासवर्ड! कृपया सही डिटेल्स डालें।" });
        }

        await ensurePhoneBandhuId(user);

        res.json({ 
            message: "लॉगिन सफल रहा! 🎉", 
            user: { id: user._id, name: user.name, email: user.email, phone: user.phone, phoneBandhuId: user.phoneBandhuId } 
        });
    } catch (err) {
        console.error("❌ Login Database Query Error:", err);
        res.status(500).json({ message: "सर्वर एरर! कृपया दोबारा प्रयास करें।" });
    }
});

app.get('/api/account/profile', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required.' });
    try {
        const user = await User.findOne({ email }).select('name email phone phoneBandhuId createdAt');
        if (!user) return res.status(404).json({ message: 'Account not found. Please sign in again.' });
        await ensurePhoneBandhuId(user);
        res.json({ id: user._id, name: user.name, email: user.email, phone: user.phone, phoneBandhuId: user.phoneBandhuId, createdAt: user.createdAt });
    } catch (err) {
        res.status(500).json({ message: 'Could not load account profile.' });
    }
});
// 📬 3. पासवर्ड भूल जाने पर (Forgot Password) रीसेट करने का रास्ता
app.post('/api/account/change-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { currentPassword, newPassword } = req.body;
    if (!email || typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ message: 'Enter your current password and a new password with at least 8 characters.' });
    }
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: 'Account not found. Please sign in again.' });
        if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: 'Current password is incorrect.' });
        if (await bcrypt.compare(newPassword, user.password)) return res.status(400).json({ message: 'Choose a new password different from your current password.' });
        user.password = await bcrypt.hash(newPassword, 10);
        user.passwordResetTokenHash = '';
        user.passwordResetExpires = null;
        await user.save();
        return res.json({ message: 'Password changed successfully.' });
    } catch (err) {
        console.error('Change Password API Error:', err);
        return res.status(500).json({ message: 'Could not change password right now. Please try again.' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "यह ईमेल आईडी डेटाबेस में रजिस्टर्ड नहीं है!" });
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER || 'your-business-email@gmail.com', 
                pass: process.env.EMAIL_PASS || 'your-app-password'             
            }
        });

        const resetToken = crypto.randomBytes(32).toString('hex');
        user.passwordResetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        user.passwordResetExpires = new Date(Date.now() + 30 * 60 * 1000);
        await user.save();
        const resetLink = `http://localhost:5500/reset-password.html?email=${encodeURIComponent(user.email)}&token=${encodeURIComponent(resetToken)}`;

        const mailOptions = {
            from: '"PhoneBandhu Support" <no-reply@phonebandhu.com>',
            to: user.email,
            subject: '🔒 Reset Your PhoneBandhu Account Password',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 disorder; border: 1px solid #e2e8f0; padding: 20px; border-radius: 12px;">
                    <h2 style="color: #022449; text-align: center;">PhoneBandhu Central</h2>
                    <p>Hello <b>${user.name}</b>,</p>
                    <p>We received a request to reset the password for your account. Click the secure button below to choose a new password:</p>
                    <div style="text-align: center; margin: 25px 0;">
                        <a href="${resetLink}" style="background-color: #022449; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset Password Now</a>
                    </div>
                    <p style="color: #64748b; font-size: 0.85rem;">If you did not request this, please ignore this email safely.</p>
                </div>
            `
        };

        console.log(`\n🔗 [SIMULATION LINK] Password Reset URL: ${resetLink}\n`);
        
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) console.warn("ℹ️ NodeMailer simulation mode active. Link outputted cleanly.");
        });

        res.json({ message: "🔒 पासवर्ड रीसेट लिंक आपके रजिस्टर्ड ईमेल पर सफलतापूर्वक भेज दी गई है!" });

    } catch (err) {
        console.error("Forgot Password System Crash:", err);
        res.status(500).json({ message: "सर्वर एरर! कृपया दोबारा प्रयास करें।" });
    }
});

// 🔒 3.5 नया पासवर्ड डेटाबेस में अपडेट करने का रास्ता (Reset Password Endpoint)
app.post('/api/auth/reset-password', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const { newPassword, token } = req.body;
    try {
        if (!email || typeof newPassword !== 'string' || newPassword.length < 8 || !token) {
            return res.status(400).json({ message: 'A valid reset link and a password of at least 8 characters are required.' });
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
        await user.save();

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
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find().select('-password').sort({ createdAt: -1 });
        for (const user of users) await ensurePhoneBandhuId(user);
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/orders', async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.patch('/api/admin/orders/:id/status', async (req, res) => {
    const allowedStatuses = ['Shipped (In Transit)', 'Delivered', 'Cancelled'];
    if (!allowedStatuses.includes(req.body.status)) return res.status(400).json({ message: 'Invalid order status.' });
    try {
        const order = await Order.findOneAndUpdate({ orderId: req.params.id }, { status: req.body.status }, { new: true, runValidators: true });
        if (!order) return res.status(404).json({ message: 'Order not found.' });
        res.json(order);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 5. Fetch Complete Live Sales Stock Catalog
app.get('/api/phones', async (req, res) => {
    try {
        // Storefront receives only sale stock; seller pickup and contact details stay private.
        const phones = await Phone.find({ status: 'Available' }).sort({ createdAt: -1 }).select('-sellerEmail -sellerName -sellerPhone -sellerPincode -pickupAddress');
        res.json(phones);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.get('/api/admin/phones', async (req, res) => {
    try {
        const phones = await Phone.find().sort({ createdAt: -1 });
        res.json(phones);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Admin catalog entries are separate from customer buyback submissions.
app.post('/api/admin/phones', async (req, res) => {
    try {
        const { brand, model, price, location, condition, images } = req.body;
        if (![brand, model, location, condition].every(value => String(value || '').trim()) || !Number.isFinite(Number(price)) || Number(price) <= 0) {
            return res.status(400).json({ message: 'Brand, model, price, location, and condition are required.' });
        }
        const imageList = Array.isArray(images) ? images.filter(value => typeof value === 'string' && value.trim()).slice(0, 6) : [];
        const phone = await new Phone({ brand: brand.trim(), model: model.trim(), price: Number(price), location: location.trim(), condition: condition.trim(), images: imageList, image: imageList[0] || '', status: 'Available' }).save();
        res.status(201).json(phone);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// 6. Submit Buyback Requests
app.post('/api/phones', async (req, res) => {
    try {
        const { brand, model, price, location, condition, image, images, sellerEmail, sellerName, sellerPhone, sellerPincode, pickupAddress, age, storage, issues, status } = req.body;
        if (![brand, model, location, condition, sellerEmail, sellerName, sellerPhone, sellerPincode, pickupAddress, storage].every(value => String(value || '').trim())) {
            return res.status(400).json({ message: 'Phone, seller contact, and pickup address details are required.' });
        }
        if (!Number.isFinite(Number(price)) || Number(price) < 0 || !/^[6-9]\d{9}$/.test(String(sellerPhone)) || !/^[1-9]\d{5}$/.test(String(sellerPincode))) {
            return res.status(400).json({ message: 'Enter a valid estimate or manual valuation, 10-digit mobile number, and 6-digit Indian PIN code.' });
        }
        const imageList = Array.isArray(images) ? images.filter(value => typeof value === 'string' && value.startsWith('data:image/')).slice(0, 6) : [];
        if (!imageList.length) return res.status(400).json({ message: 'At least one phone photo is required.' });
        const newPhone = new Phone({
            brand: brand.trim(),
            model: model.trim(),
            price: Number(price),
            location: location.trim(),
            condition: condition.trim(),
            image: image || imageList[0],
            images: imageList,
            issues: issues || {},
            sellerEmail,
            sellerName: sellerName.trim(),
            sellerPhone: String(sellerPhone),
            sellerPincode: String(sellerPincode),
            pickupAddress: pickupAddress.trim(),
            age,
            storage,
            status: status || 'Pending Valuation Approval'
        });
        const savedPhone = await newPhone.save();
        res.status(201).json(savedPhone);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// 7. Delete Phone Listings
app.delete('/api/admin/phones/:id', async (req, res) => {
    try {
        const deletedPhone = await Phone.findByIdAndDelete(req.params.id);
        if (!deletedPhone) return res.status(404).json({ message: "Phone listing not found" });
        res.json({ message: "Phone listing deleted successfully!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 8. Remove User Profiles
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id);
        if (!deletedUser) return res.status(404).json({ message: "User not found" });
        res.json({ message: "User removed from database successfully!" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 9. Customer orders and Razorpay online checkout
app.get('/api/payments/config', (req, res) => {
    res.json({ onlineEnabled: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) });
});

app.post('/api/payments/create-order', async (req, res) => {
    const { productId, customerName, customerPhone, customerEmail, address, pincode } = req.body;
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return res.status(503).json({ message: 'Online payments are not configured yet. Please use cash on delivery.' });
    }
    if (![customerName, customerPhone, customerEmail, address, pincode, productId].every(value => String(value || '').trim())) {
        return res.status(400).json({ message: 'Please complete all delivery details.' });
    }
    try {
        if (!mongoose.isValidObjectId(productId)) return res.status(400).json({ message: 'This item is not available for online checkout.' });
        const phone = await Phone.findById(productId);
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
        await new Order({ orderId, product: phone.model, price: `₹${Number(phone.price).toLocaleString('en-IN')}`, customerName, customerPhone, customerEmail, address, pincode, paymentMethod: 'Razorpay', gatewayOrderId: gatewayOrder.id, status: 'Payment Pending' }).save();
        res.status(201).json({ keyId: process.env.RAZORPAY_KEY_ID, gatewayOrderId: gatewayOrder.id, amount, currency: 'INR', orderId });
    } catch (err) {
        console.error('Razorpay order creation failed:', err);
        res.status(500).json({ message: 'Could not start payment. Please try again.' });
    }
});

app.post('/api/payments/verify', async (req, res) => {
    const { internalOrderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({ message: 'Payment verification is not configured.' });
    try {
        const order = await Order.findOne({ orderId: internalOrderId, gatewayOrderId: razorpay_order_id });
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
app.post('/api/orders', async (req, res) => {
    let reservedPhones = [];
    try {
        const { productId, productIds, customerName, customerPhone, customerEmail, address, pincode } = req.body;
        const requestedIds = Array.isArray(productIds) ? [...new Set(productIds.map(String))] : [String(productId || '')];
        if (!requestedIds.length || requestedIds.length > 8 || ![customerName, customerPhone, customerEmail, address, pincode].every(value => String(value || '').trim())) {
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
        const orders = await Order.insertMany(reservedPhones.map(phone => ({ orderId: `PB-ORD-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, product: phone.model, price: `${currency}${Number(phone.price).toLocaleString('en-IN')}`, customerName, customerPhone, customerEmail: customerEmail.trim().toLowerCase(), address, pincode, paymentMethod: 'COD', status: 'Order Placed (COD)' })));
        res.status(201).json({ orders, orderIds: orders.map(order => order.orderId), orderId: orders[0]?.orderId });
    } catch (err) {
        if (reservedPhones.length) await Phone.updateMany({ _id: { $in: reservedPhones.map(item => item._id) }, status: 'Sold' }, { $set: { status: 'Available' } }).catch(() => {});
        res.status(400).json({ message: err.message });
    }
});

app.get('/api/orders', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required.' });
    try {
        const orders = await Order.find({ customerEmail: email }).sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 10. Chat Thread Reload History API
app.get('/api/chats/:roomId', async (req, res) => {
    try {
        const history = await ChatLog.find({ roomId: req.params.roomId }).sort({ timestamp: 1 });
        res.json(history);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ==========================================
// ⚡ SOCKET.IO DYNAMIC NETWORK BROADCASTING PIPES
// ==========================================
io.on('connection', (socket) => {
    console.log(`⚡ Live User Connected via WebSockets: ${socket.id}`);

    socket.on('join_room', async (roomId) => {
        socket.join(roomId);
        console.log(`🚪 Socket Channel ID ${socket.id} locked into Room: ${roomId}`);
    });

    socket.on('send_live_message', async (data) => {
        const { roomId, sender, text, time } = data;
        try {
            const logEntry = new ChatLog({ roomId, sender, text, time });
            await logEntry.save();
            io.to(roomId).emit('receive_live_message', data);
        } catch(dbErr) {
            console.error("Error storing web socket packets to database:", dbErr);
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Live Connection Channel disconnected: ${socket.id}`);
    });
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
