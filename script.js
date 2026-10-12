// ⚡ Connect to the Node.js Live Socket Server Network Core
const API_ORIGIN = window.location.protocol === 'file:' || window.location.port === '5500' ? 'http://localhost:5200' : window.location.origin;
const socket = typeof io === 'function' ? io(API_ORIGIN) : null;
const API_URL = `${API_ORIGIN}/api/phones`;
let phoneData = [];
let selectedBrand = 'all';
let searchQuery = '';

function createPhoneBandhuId() {
    return `PB-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

// HTML Elements Mapping
const modal = document.getElementById('sellModal');
const form = document.getElementById('sellPhoneForm');
const listingsGrid = document.getElementById('listingsGrid');
const searchInput = document.getElementById('searchInput');
const brandChips = document.querySelectorAll('.chip');
const emptyState = document.getElementById('emptyState');
const heroBrowseBtn = document.getElementById('heroBrowseBtn');

function getCurrentUser() { try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { return null; } }
function scopedStorageKey(kind, email) { return `phoneBandhu_${kind}_${encodeURIComponent(String(email || 'guest').trim().toLowerCase())}`; }
function getCartIds(email = getCurrentUser()?.email) { try { const value = JSON.parse(localStorage.getItem(scopedStorageKey('cart', email)) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
function updateCartBadges() { const total = getCartIds().length; document.querySelectorAll('.cart-count').forEach(badge => { badge.textContent = total; badge.setAttribute('aria-label', `${total} items in cart`); }); }
function getFavoriteIds(email = getCurrentUser()?.email) { try { const value = JSON.parse(localStorage.getItem(scopedStorageKey('favorites', email)) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }

function addPhoneToCart(phone) {
    if (!phone?._id) { alert('This phone cannot be added to cart right now.'); return; }
    const ids = getCartIds();
    if (ids.includes(String(phone._id))) { alert('This phone is already in your cart.'); return; }
    if (ids.length >= 8) { alert('Cart limit is 8 phones at a time.'); return; }
    ids.push(String(phone._id));
    localStorage.setItem(scopedStorageKey('cart', getCurrentUser()?.email), JSON.stringify(ids));
    updateCartBadges();
    alert(`${phone.model || 'Phone'} added to your cart.`);
}

function togglePhoneFavorite(phone) {
    const user = getCurrentUser();
    if (!user?.email) {
        sessionStorage.setItem('phoneBandhuReturnTo', 'index.html');
        alert('Please log in to save liked phones to your account.');
        location.href = 'auth.html';
        return;
    }
    const ids = getFavoriteIds(user.email);
    const id = String(phone?._id || '');
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    localStorage.setItem(scopedStorageKey('favorites', user.email), JSON.stringify(next));
    renderListings();
    renderSavedListings(user);
}

document.getElementById('profilePhotoInput')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    const user = getCurrentUser();
    if (!file || !user?.email) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 700 * 1024) { alert('Choose a JPG, PNG or WebP image smaller than 700 KB.'); event.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
        try { localStorage.setItem(scopedStorageKey('avatar', user.email), reader.result); document.getElementById('profileAvatar').src = reader.result; }
        catch { alert('Photo could not be saved. Please choose a smaller image.'); }
    };
    reader.readAsDataURL(file);
});

// 👤 1. यूजर ऑथेंटिकेशन और डायनामिक नेविगेशन बार अपडेट सिस्टम
function checkUserSession() {
    updateCartBadges();
    const authContainer = document.getElementById('navAuthContainer');
    let currentUser = null;
    try {
        currentUser = JSON.parse(localStorage.getItem('currentUser'));
    } catch (error) {
        localStorage.removeItem('currentUser');
    }

    if (!authContainer) return;

    if (currentUser) {
        // अगर यूजर लॉगिन है, तो उसे उसका नाम और ड्रॉपडाउन प्रोफाइल बटन दिखाएं
        authContainer.innerHTML = '<a class="cart-nav-link" href="cart.html" aria-label="Shopping cart">Cart <span class="cart-count" id="cartCount">0</span></a><button id="userMenuBtn" type="button" class="btn btn-secondary"></button>';
        const profileButton = document.getElementById('userMenuBtn');
        updateCartBadges();
        if (profileButton) profileButton.textContent = `👤 Hi, ${(currentUser.name || 'Bandhu').split(' ')[0]} ▾`;

        // प्रोफाइल मॉडल खोलने का इवेंट बाइंड करें
        const openAccount = () => {
            document.getElementById('profName').textContent = currentUser.name || '';
            document.getElementById('profEmail').textContent = currentUser.email || '';
            const profileId = document.getElementById('profPhoneBandhuId');
            if (profileId) profileId.innerText = currentUser.phoneBandhuId || 'Not available';
            ensureAccountOrdersSection();
            updateCartBadges();
            const avatar = document.getElementById('profileAvatar');
            if (avatar) avatar.src = localStorage.getItem(scopedStorageKey('avatar', currentUser.email)) || 'logo.png.jpg';
            renderSavedListings(currentUser);
            const resetLink = document.getElementById('accountResetPassword');
            if (resetLink) resetLink.href = `auth.html?mode=forgot&email=${encodeURIComponent(currentUser.email || '')}`;
            loadPhoneBandhuProfile(currentUser);
            loadMyOrders(currentUser.email);
            
            // यूजर के खुद के लिस्ट किये फोन लोड करें
            renderUserOwnedPhones(currentUser.email);
            
            document.getElementById('profileModal').style.display = 'flex';
        };
        document.getElementById('userMenuBtn')?.addEventListener('click', openAccount);
        document.getElementById('footerMyAccountLink')?.addEventListener('click', event => {
            event.preventDefault();
            openAccount();
        });
    }
}

// यूजर के खुद के अपलोड किये गए फोन्स को प्रोफाइल के अंदर दिखाना
function ensureAccountOrdersSection() {
    const accountForm = document.querySelector('#profileModal .modal-scrollable-form');
    const buybackList = document.getElementById('myListedPhonesContainer');
    if (!accountForm || !buybackList) return;
    if (!document.getElementById('myOrdersSection')) {
        const section = document.createElement('section');
        section.id = 'myOrdersSection';
        section.className = 'account-section';
        section.innerHTML = '<div class="account-section-heading"><div><span class="account-eyebrow">PURCHASES</span><h4>My Orders</h4></div><span id="myOrdersCount" class="account-count">0 orders</span></div><div id="myOrdersContainer" class="account-orders-list"><p class="account-empty-state">Loading your orders…</p></div>';
        accountForm.insertBefore(section, buybackList.parentElement);
    }
    if (!document.getElementById('accountTools')) {
        const tools = document.createElement('div');
        tools.id = 'accountTools';
        tools.className = 'account-tools';
        tools.innerHTML = '<button id="toggleChangePassword" class="account-tool-link" type="button">Change password</button><a id="accountResetPassword" class="account-tool-link" href="auth.html">Forgot password by email</a><a class="account-tool-link" href="cart.html">Open cart <span class="cart-count">0</span></a>';
        accountForm.insertBefore(tools, buybackList.parentElement);
    }
    if (!document.getElementById('changePasswordForm')) {
        const changeForm = document.createElement('form');
        changeForm.id = 'changePasswordForm';
        changeForm.className = 'account-password-form';
        changeForm.hidden = true;
        changeForm.innerHTML = '<h4>Change your password</h4><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password<input name="newPassword" type="password" minlength="8" autocomplete="new-password" required><small>Use at least 8 characters.</small></label><label>Confirm new password<input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></label><p class="account-password-message" role="status" aria-live="polite"></p><div class="account-password-actions"><button type="button" class="account-password-cancel">Cancel</button><button type="submit" class="account-password-submit">Update password</button></div>';
        accountForm.insertBefore(changeForm, buybackList.parentElement);
        const toggle = document.getElementById('toggleChangePassword');
        toggle?.addEventListener('click', () => { changeForm.hidden = !changeForm.hidden; if (!changeForm.hidden) changeForm.querySelector('input')?.focus(); });
        changeForm.querySelector('.account-password-cancel')?.addEventListener('click', () => { changeForm.reset(); changeForm.hidden = true; changeForm.querySelector('.account-password-message').textContent = ''; });
        changeForm.addEventListener('submit', async event => {
            event.preventDefault();
            const fields = new FormData(changeForm);
            const currentPassword = fields.get('currentPassword');
            const newPassword = fields.get('newPassword');
            const confirmPassword = fields.get('confirmPassword');
            const message = changeForm.querySelector('.account-password-message');
            if (newPassword !== confirmPassword) { message.textContent = 'New password and confirmation do not match.'; message.dataset.state = 'error'; return; }
            if (newPassword.length < 8) { message.textContent = 'New password must be at least 8 characters.'; message.dataset.state = 'error'; return; }
            const submit = changeForm.querySelector('.account-password-submit');
            submit.disabled = true; submit.textContent = 'Updating…'; message.textContent = '';
            try {
                const user = getCurrentUser();
                const response = await fetch(`${API_ORIGIN}/api/account/change-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user?.email, currentPassword, newPassword }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Password could not be changed.');
                message.textContent = result.message || 'Password changed successfully.'; message.dataset.state = 'success';
                changeForm.reset();
                setTimeout(() => { changeForm.hidden = true; message.textContent = ''; }, 2200);
            } catch (error) { message.textContent = error.message || 'Could not reach the server. Please try again.'; message.dataset.state = 'error'; }
            finally { submit.disabled = false; submit.textContent = 'Update password'; }
        });
    }
    if (!document.getElementById('savedListingsSection')) {
        const section = document.createElement('section');
        section.id = 'savedListingsSection';
        section.className = 'account-section';
        section.innerHTML = '<div class="account-section-heading"><div><span class="account-eyebrow">SAVED FOR LATER</span><h4>Liked phones</h4></div><span class="account-count" id="savedListingsCount">0 saved</span></div><div class="account-saved-grid" id="savedListingsContainer"><p class="account-empty-state">Your liked phone listings will appear here.</p></div>';
        accountForm.insertBefore(section, buybackList.parentElement);
    }
    const idLine = [...document.querySelectorAll('#profileModal p')].find(line => line.textContent.includes('PhoneBandhu ID'));
    if (idLine && !document.getElementById('copyPhoneBandhuId')) {
        idLine.classList.add('account-id-line');
        const copy = document.createElement('button');
        copy.id = 'copyPhoneBandhuId';
        copy.className = 'account-copy-button';
        copy.type = 'button';
        copy.textContent = 'Copy ID';
        copy.addEventListener('click', async () => {
            const id = document.getElementById('profPhoneBandhuId')?.textContent || '';
            try { await navigator.clipboard.writeText(id); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy ID', 1400); }
            catch { alert(`Your PhoneBandhu ID: ${id}`); }
        });
        idLine.append(' ', copy);
    }
}

function renderSavedListings(user = getCurrentUser()) {
    const container = document.getElementById('savedListingsContainer');
    const count = document.getElementById('savedListingsCount');
    if (!container || !count || !user?.email) return;
    const ids = getFavoriteIds(user.email);
    const saved = phoneData.filter(phone => ids.includes(String(phone._id)));
    count.textContent = `${saved.length} saved`;
    if (!saved.length) { container.innerHTML = '<p class="account-empty-state">No liked phones yet. Tap the heart on a listing to save it.</p>'; return; }
    container.innerHTML = saved.map(phone => {
        const image = (phone.images?.[0] || phone.image || '').replace(/"/g, '&quot;');
        return `<article class="account-saved-item"><img src="${image || 'logo.png.jpg'}" alt="${escapeAccountHtml(phone.model)}"><div><strong>${escapeAccountHtml(phone.brand)} ${escapeAccountHtml(phone.model)}</strong><small>${String.fromCharCode(8377)}${Number(phone.price || 0).toLocaleString('en-IN')}</small></div><button type="button" class="account-saved-remove" data-unlike-id="${escapeAccountHtml(phone._id)}">Remove</button></article>`;
    }).join('');
    container.querySelectorAll('[data-unlike-id]').forEach(button => button.addEventListener('click', () => {
        localStorage.setItem(scopedStorageKey('favorites', user.email), JSON.stringify(getFavoriteIds(user.email).filter(id => id !== button.dataset.unlikeId)));
        renderSavedListings(user); renderListings();
    }));
}

async function loadPhoneBandhuProfile(currentUser) {
    try {
        const response = await fetch(`${API_ORIGIN}/api/account/profile?email=${encodeURIComponent(currentUser.email || '')}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Could not load profile.');
        const updatedUser = { ...currentUser, ...result };
        localStorage.setItem('currentUser', JSON.stringify(updatedUser));
        document.getElementById('profName').textContent = result.name || currentUser.name || '';
        document.getElementById('profEmail').textContent = result.email || currentUser.email || '';
        document.getElementById('profPhoneBandhuId').textContent = result.phoneBandhuId;
    } catch (error) {
        const profileId = document.getElementById('profPhoneBandhuId');
        if (profileId && !currentUser.phoneBandhuId) profileId.textContent = error.message || 'Unavailable';
    }
}

async function loadMyOrders(userEmail) {
    const container = document.getElementById('myOrdersContainer');
    const count = document.getElementById('myOrdersCount');
    if (!container) return;
    container.innerHTML = '<p class="account-empty-state">Loading your orders…</p>';
    try {
        const response = await fetch(`${API_ORIGIN}/api/orders?email=${encodeURIComponent(userEmail || '')}`);
        const orders = await response.json();
        if (!response.ok) throw new Error(orders.message || 'Could not load your orders.');
        let localOrders = [];
        try { localOrders = JSON.parse(localStorage.getItem('phoneBandhuOrders') || '[]'); } catch {}
        const knownOrderIds = new Set(orders.map(order => order.orderId));
        localOrders.filter(order => order.customerEmail === userEmail && !knownOrderIds.has(order.orderId)).forEach(order => orders.push(order));
        orders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        count.textContent = `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`;
        container.innerHTML = '';
        if (!orders.length) {
            container.innerHTML = '<div class="account-empty-state"><strong>No orders yet</strong><span>Your PhoneBandhu purchases and delivery updates will appear here.</span><a href="#marketplaceView" onclick="document.getElementById(\'profileModal\').style.display=\'none\'">Explore phones</a></div>';
            return;
        }
        orders.forEach(order => {
            const card = document.createElement('article');
            card.className = 'account-order-card';
            const status = order.status || 'Order Placed';
            const isCancelled = /cancel/i.test(status);
            const stage = isCancelled ? -1 : /deliver/i.test(status) ? 2 : /ship|transit/i.test(status) ? 1 : 0;
            const date = order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
            card.innerHTML = `<div class="account-order-top"><div><span class="account-order-label">ORDER ${escapeAccountHtml(order.orderId || '')}</span><h5>${escapeAccountHtml(order.product || 'PhoneBandhu phone')}</h5></div><span class="account-status-pill ${isCancelled ? 'is-cancelled' : 'is-active'}">${escapeAccountHtml(status)}</span></div><div class="account-order-meta"><span>${date ? `Placed ${date}` : 'Order placed'}</span><strong>${escapeAccountHtml(order.price || '')}</strong></div>${isCancelled ? '<p class="account-cancel-note">This order was cancelled.</p>' : `<div class="order-progress" aria-label="Order progress"><span class="${stage >= 0 ? 'complete' : ''}">Placed</span><i class="${stage >= 1 ? 'complete' : ''}"></i><span class="${stage >= 1 ? 'complete' : ''}">Shipped</span><i class="${stage >= 2 ? 'complete' : ''}"></i><span class="${stage >= 2 ? 'complete' : ''}">Delivered</span></div>`}<details class="account-order-details"><summary>Delivery details</summary><p>${escapeAccountHtml(order.address || '')}, ${escapeAccountHtml(order.pincode || '')}</p><p>Payment: ${escapeAccountHtml(order.paymentMethod || 'COD')}</p></details>`;
            container.appendChild(card);
        });
    } catch (error) {
        count.textContent = '—';
        container.innerHTML = `<p class="account-empty-state">${escapeAccountHtml(error.message || 'Unable to load orders. Please try again.')}</p>`;
    }
}

function escapeAccountHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function renderUserOwnedPhones(userEmail) {
    const container = document.getElementById('myListedPhonesContainer');
    if (!container) return;

    let localList = [];
    try {
        localList = JSON.parse(localStorage.getItem('phoneListings')) || [];
    } catch (error) {
        localStorage.removeItem('phoneListings');
    }
    localList = localList.filter(item => item.sellerEmail === userEmail);
    container.innerHTML = '';

    if (localList.length === 0) {
        container.innerHTML = `<p style="color: #64748b; font-size: 0.9rem; padding: 5px;">No active phone listings found.</p>`;
    } else {
        localList.forEach(item => {
            const div = document.createElement('div');
            div.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding: 6px; border-bottom: 1px solid #f1f5f9; font-size: 0.9rem;";
            div.innerHTML = `
                <span><b>${item.brand}</b> - ${item.model}</span>
                <span style="color:#0d9488; font-weight:700;">₹${parseInt(item.expectedPrice).toLocaleString('en-IN')}</span>
            `;
            container.appendChild(div);
        });
    }
}

// 📌 लॉगआउट (Logout) करने का लॉजिक
document.body.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'logoutBtn') {
        localStorage.removeItem('currentUser'); // Session saaf karein
        alert('🔒 आप सफलतापूर्वक लॉगआउट हो चुके हैं।');
        window.location.reload();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    checkUserSession();
});

// --- ब्रांड्स की मार्केट बेस प्राइस ---
const BUYBACK_MODELS = {
 Apple:[['iPhone 18 Pro Max ',108000],['iPhone 18 Pro ',95000],['iPhone 17 Pro Max ',82000],['iPhone 17 ',57000],['iPhone 16 Pro ',69000],['iPhone 16 ',47000],['iPhone 15 ',38000],['iPhone 14 ',29000],['iPhone 13 ',22000],['iPhone 12 ',15000]],
 Samsung:[['Galaxy S26 Ultra ',88000],['Galaxy S26+ ',71000],['Galaxy S26 ',58000],['Galaxy S25 Ultra ',76000],['Galaxy S25 ',44000],['Galaxy S24 Ultra ',57000],['Galaxy S24 ',34000],['Galaxy S23 FE ',19000],['Galaxy A56 5G ',18000],['Galaxy A36 5G ',13000]],
 OnePlus:[['OnePlus 15 ',50000],['OnePlus 13 ',44000],['OnePlus 13R ',29000],['OnePlus 12 ',32000],['OnePlus 12R ',22000],['OnePlus 11 ',21000],['OnePlus Nord 4 ',17000],['OnePlus Nord CE4 ',11500]],
 Xiaomi:[['Xiaomi 17 Ultra ',62000],['Xiaomi 17 ',44000],['Xiaomi 15 ',39000],['Xiaomi 14 ',30000],['Redmi Note 14 Pro+ ',19000],['Redmi Note 14 Pro ',14500],['Redmi Note 13 Pro+ ',15000],['Redmi Note 13 ',9500]],
 POCO:[['POCO F8 Ultra ',34000],['POCO F8 Pro ',28000],['POCO F7 ',23000],['POCO X7 Pro ',18000],['POCO X7 ',12500],['POCO F6 ',17000],['POCO X6 Pro ',12500]],
 Vivo:[['Vivo X300 Pro ',57000],['Vivo X300 ',42000],['Vivo X200 Pro ',57000],['Vivo V50 Pro ',30000],['Vivo V50 ',21000],['Vivo V40 ',19000],['Vivo T4 5G ',12000]],
 OPPO:[['OPPO Find X9 Ultra ',105000],['OPPO Find X9s ',48000],['OPPO Find X9 Pro ',72000],['OPPO Find X9 ',55000],['OPPO Find X8 Pro ',53000],['OPPO Reno13 Pro ',30000],['OPPO Reno13 ',20500],['OPPO F29 Pro ',15000],['OPPO A5 Pro 5G ',9500]],
 realme:[['realme GT 7 Pro ',36000],['realme GT 6 ',23000],['realme 14 Pro+ ',20500],['realme 13 Pro+ ',15500],['realme P3 Pro ',13000]],
 Google:[['Pixel 9 Pro XL ',62000],['Pixel 9 ',40000],['Pixel 8 Pro ',37000],['Pixel 8 ',26000],['Pixel 7a ',15000]],
 Motorola:[['Motorola Edge 60 Pro ',27000],['Motorola Edge 50 Pro ',22000],['Motorola Edge 50 Fusion ',13500],['Motorola Razr 50 ',25000],['Moto G85 5G ',10500]],
 Nothing:[['Nothing Phone (3) ',38000],['Nothing Phone (3a) Pro ',22000],['Nothing Phone (2a) Plus ',16500],['Nothing Phone (2a) ',13500],['CMF Phone 2 Pro ',12500]],
 iQOO:[['iQOO 13 ',39000],['iQOO Neo 10 ',23000],['iQOO 12 ',30000],['iQOO Neo 9 Pro ',21000],['iQOO Z10 ',12000]],
 HONOR:[['HONOR Magic7 Pro ',58000],['HONOR 200 Pro ',27000],['HONOR 200 ',20500],['HONOR X9c ',16500]],
 Tecno:[['Phantom V Fold2 ',37000],['Camon 40 Premier ',22000],['Camon 40 Pro ',15000],['Pova 7 Pro ',12000]],
 Infinix:[['ZERO Flip ',26000],['GT 30 Pro ',18500],['Note 50 Pro+ ',17000],['Note 50s 5G+ ',11000]],
 LAVA:[['Agni 4 ',17000],['Agni 3 ',11000],['Blaze X ',8500],['Blaze 3 ',6000]],
 itel:[['S25 Ultra ',7000],['P65 ',5000],['S24 ',4000]]
};
const ADDITIONAL_BUYBACK_MODELS={
 Apple:[['iPhone 14 Pro',42000],['iPhone 13 Pro',32000],['iPhone 15 Pro',56000],['iPhone 15 Pro Max',68000],['iPhone 16 Pro Max',76000],['iPhone 17 Pro',75000],['iPhone 11 Pro Max',14500],['iPhone 11 Pro',12500],['iPhone 11',12000],['iPhone XS Max',9000],['iPhone XS',7500],['iPhone XR',7000],['iPhone X',5500],['iPhone SE 2022',6500]],
 Samsung:[['Galaxy A55 5G',16000],['Galaxy A54 5G',12500],['Galaxy A35 5G',11500],['Galaxy A34 5G',9000],['Galaxy A25 5G',8000],['Galaxy A15 5G',7000],['Galaxy S23 Ultra',46000],['Galaxy S23',24000],['Galaxy S22 Ultra',30000],['Galaxy S22',17000],['Galaxy Z Flip5',26000],['Galaxy Z Fold5',48000]],
 OnePlus:[['OnePlus 10 Pro',16000],['OnePlus 10T',13000],['OnePlus 10R',12000],['OnePlus 9 Pro',11500],['OnePlus Nord 3',12500],['OnePlus Nord CE 3 Lite',7500],['OnePlus Nord 2T',8000]],
 Xiaomi:[['Redmi Note 13 5G',10000],['Redmi Note 12 Pro 5G',11500],['Redmi Note 12 5G',7500],['Redmi Note 11 Pro',6500],['Redmi Note 10 Pro',5500],['Redmi 13C',6000],['Redmi 12 5G',7000],['Redmi 10',4000],['Redmi 9',2500]],
 POCO:[['POCO X6',8500],['POCO X5 Pro',9000],['POCO X5',6500],['POCO M6 Pro',7000],['POCO M6',5500],['POCO M5',4000],['POCO F5',12000]],
 Vivo:[['Vivo V30',18000],['Vivo X100 Pro',48000],['Vivo X100',33000],['Vivo V29',14000],['Vivo Y200',10500],['Vivo Y100',8500],['Vivo T3',8000],['Vivo Y20',3500]],
 OPPO:[['OPPO Find X7 Ultra',45000],['OPPO Reno12 Pro',18000],['OPPO Reno12',14000],['OPPO Reno11 Pro',15000],['OPPO Reno10 Pro',12000],['OPPO F27 Pro+',11000],['OPPO A78',6000],['OPPO A58',5000]],
 realme:[['realme 12 Pro+',15500],['realme GT 6T',21000],['realme 12 Pro',12500],['realme 12 5G',10000],['realme 11 Pro+',13000],['realme 11 Pro',9500],['realme 9 5G',6000],['realme C67',5500],['realme C55',4500]],
 Google:[['Pixel 8a',22000],['Pixel 7 Pro',20000],['Pixel 7',18000],['Pixel 6a',10500],['Pixel 6',12000],['Pixel 6 Pro',15000]],
 Motorola:[['Moto Edge 50 Ultra',29000],['Moto Edge 50 Neo',14000],['Moto Edge 40 Neo',10500],['Moto Edge 40',12000],['Moto G84',8000],['Moto G54',5500],['Moto G34',4500],['Moto G52',4500]],
 Nothing:[['Nothing Phone (1)',9000],['CMF Phone 1',7500]],
 iQOO:[['iQOO 11',22000],['iQOO 11 Pro',26000],['iQOO Neo 7 Pro',14000],['iQOO Neo 7',11000],['iQOO Z9',8000],['iQOO Z7 Pro',9500]],
 HONOR:[['HONOR 90',16000],['HONOR X9b',11500],['HONOR X8b',8500],['HONOR X7b',6500]],
 Tecno:[['Phantom V Fold2',37000],['Camon 40 Premier',22000],['Camon 40 Pro',15000],['Pova 7 Pro',12000],['Camon 30 Premier',15000],['Spark 30 Pro',7000],['Pova 6 Pro',9000]],
 Infinix:[['ZERO Flip',26000],['GT 30 Pro',18500],['Note 50 Pro+',17000],['Note 50s 5G+',11000],['GT 20 Pro',12000],['Note 40 Pro',10000],['Note 30 5G',6500],['Hot 40 Pro',6000]],
 LAVA:[['Agni 4',17000],['Agni 3',11000],['Blaze X',8500],['Blaze 3',6000],['Blaze 2',4500],['Blaze 5G',3500]],
 itel:[['S25 Ultra',7000],['P65',5000],['S24',4000],['S23',3500],['A70',3000]],
 Lenovo:[['Legion Phone Duel',12000],['K14 Plus',4000],['K13 Note',3500]],
 Nokia:[['G42 5G',6500],['G60 5G',7000],['X30 5G',11000],['C32',3000],['7.2',2500]],
 ASUS:[['ROG Phone 8 Pro',45000],['ROG Phone 7',30000],['Zenfone 10',26000],['Zenfone 9',18000]],
 LG:[['Wing',9000],['V60 ThinQ',9000],['G8X ThinQ',4500]]
};
Object.entries(ADDITIONAL_BUYBACK_MODELS).forEach(([brand,models])=>{BUYBACK_MODELS[brand]=[...(BUYBACK_MODELS[brand]||[]),...models];});
const PHONEBANDHU_REFERENCE_PRICES={
 'Apple|iPhone 11|64 GB':12490,'Apple|iPhone 11|128 GB':14150,'Apple|iPhone 12|64 GB':16490,'Apple|iPhone 12|128 GB':17420,
 'Apple|iPhone 13|128 GB':24760,'Apple|iPhone 13 Pro|128 GB':32940,'Apple|iPhone 14|128 GB':27780,'Apple|iPhone 14 Pro|128 GB':42690,
 'Apple|iPhone 15|128 GB':42220,'Apple|iPhone 15|256 GB':43270,'Apple|iPhone 16|128 GB':52900,
 'Samsung|Galaxy S24|128 GB':32160,'Samsung|Galaxy A55 5G|128 GB':16530,
 'OnePlus|OnePlus 12|512 GB':38040,'OnePlus|OnePlus 12R|128 GB':24920,'OnePlus|OnePlus 12R|256 GB':26940,
 'Vivo|Vivo V30|128 GB':18730,'Xiaomi|Redmi Note 13 5G|256 GB':10380,'POCO|POCO X6 Pro|256 GB':15140,
 'realme|realme 12 Pro+|256 GB':15840,'Google|Pixel 8|128 GB':24950
};
const ISSUE_PENALTIES={checkScreen:.28,checkTouch:.24,checkBody:.10,checkWater:.38,checkBattery:.12,checkCharge:.15,checkCamera:.20,checkAudio:.08,checkButtons:.10,checkBiometric:.14,checkRepair:.12,checkBillBox:.025,checkWarranty:.035};
const ISSUE_FIELD_MAP={checkScreen:'screenBroken',checkTouch:'displayTouchIssue',checkBody:'bodyDents',checkWater:'waterDamage',checkBattery:'batteryLow',checkCharge:'chargingIssue',checkCamera:'cameraIssue',checkAudio:'audioIssue',checkButtons:'buttonOrNetworkIssue',checkBiometric:'biometricIssue',checkRepair:'repairedOrNonOriginalParts',checkBillBox:'missingBillBox',checkWarranty:'outOfWarranty'};
const ageFactors=[1,.88,.73,.57,.41,.28];
function populateBuybackBrands(){const select=document.getElementById('phoneBrand');Object.keys(BUYBACK_MODELS).forEach(brand=>select?.add(new Option(brand,brand)));}
function updateBasePrice(){const brand=document.getElementById('phoneBrand')?.value,model=document.getElementById('phoneModel');if(!model)return;model.innerHTML='<option value="" disabled selected>Select your model</option>';(BUYBACK_MODELS[brand]||[]).forEach(([name,price])=>model.add(new Option(name.trim()+' (select storage for price)',name.trim())));model.add(new Option('My model is not listed', '__other__'));model.disabled=false;document.getElementById('phoneCustomModel').style.display='none';document.getElementById('phoneCustomModel').required=false;document.getElementById('phoneModelHint').textContent=(BUYBACK_MODELS[brand]||[]).length+' listed models plus manual entry for any other phone. Choose the exact storage for available references.';calculateLivePrice();}
function calculateLivePrice(){const brand=document.getElementById('phoneBrand')?.value,choice=document.getElementById('phoneModel')?.value,custom=document.getElementById('phoneCustomModel'),modelName=choice==='__other__'?(custom?.value.trim()||''):choice,storage=document.getElementById('phoneStorage')?.value,age=Number(document.getElementById('phoneAge')?.value),selected=(BUYBACK_MODELS[brand]||[]).find(([name])=>name.trim()===modelName);if(choice==='__other__'){document.getElementById('suggestedPriceDisplay').textContent=custom?.value.trim()?'Manual valuation after inspection':'Enter model for manual valuation';document.getElementById('expectedPrice').value=0;document.getElementById('sellPriceSource').textContent='This model needs a manual PhoneBandhu inspection.';return;}if(!selected){document.getElementById('suggestedPriceDisplay').textContent='Select a model';document.getElementById('expectedPrice').value='';return;}const referencePrice=PHONEBANDHU_REFERENCE_PRICES[brand+'|'+modelName+'|'+storage];let price=referencePrice??selected[1]*(ageFactors[age]??1);Object.entries(ISSUE_PENALTIES).forEach(([id,penalty])=>{if(document.getElementById(id)?.checked)price*=1-penalty;});price=Math.max(500,Math.round(price/100)*100);document.getElementById('suggestedPriceDisplay').textContent='\u20B9'+price.toLocaleString('en-IN');document.getElementById('expectedPrice').value=price;document.getElementById('sellPriceSource').textContent=referencePrice?'PhoneBandhu indicative reference price; final offer is confirmed after inspection.':'PhoneBandhu indicative estimate; final offer is confirmed after inspection.';}
populateBuybackBrands();document.getElementById('phoneBrand')?.addEventListener('change',updateBasePrice);document.getElementById('phoneModel')?.addEventListener('change',()=>{const isCustom=document.getElementById('phoneModel').value==='__other__',input=document.getElementById('phoneCustomModel');input.style.display=isCustom?'block':'none';input.required=isCustom;if(!isCustom)input.value='';calculateLivePrice();});document.getElementById('phoneCustomModel')?.addEventListener('input',calculateLivePrice);document.getElementById('phoneAge')?.addEventListener('change',calculateLivePrice);document.getElementById('phoneStorage')?.addEventListener('change',calculateLivePrice);Object.keys(ISSUE_PENALTIES).forEach(id=>document.getElementById(id)?.addEventListener('change',calculateLivePrice));
document.getElementById('sellPhoneOpenBtn')?.addEventListener('click',()=>{let user=null;try{user=JSON.parse(localStorage.getItem('currentUser')||'null');}catch{}if(user){document.getElementById('sellerName').value=user.name||'';document.getElementById('sellerPhone').value=user.phone||'';}});
document.getElementById('phoneImage')?.addEventListener('change',event=>{const files=[...event.target.files],preview=document.getElementById('sellPhotoPreviews');if(files.length>6||files.some(file=>!file.type.startsWith('image/')||file.size>1024*1024)){alert('Choose up to 6 image files, each 1 MB or smaller.');event.target.value='';preview.replaceChildren();return;}preview.replaceChildren(...files.map(file=>{const image=document.createElement('img');image.alt='Phone photo preview: '+file.name;image.src=URL.createObjectURL(file);image.onload=()=>URL.revokeObjectURL(image.src);return image;}));});
// --- 1. बैकएंड + लोकलस्टोरेज से डेटा लोड करने का फंक्शन (FETCH) ---
async function fetchPhonesFromBackend() {
    try {
        const response = await fetch(API_URL);
        if(response.ok) {
            phoneData = await response.json();
            const stockStatus = document.getElementById('stockStatus');
            if (stockStatus) stockStatus.textContent = `${phoneData.length} live phone${phoneData.length === 1 ? '' : 's'} from PhoneBandhu`;
        } else {
            throw new Error("Backend error");
        }
    } catch (err) {
        console.warn('Backend offline, loading from LocalStorage...');
        phoneData = JSON.parse(localStorage.getItem('phoneListings')) || [];
        const stockStatus = document.getElementById('stockStatus');
        if (stockStatus) stockStatus.textContent = 'Showing saved stock · reconnecting to server';
    }
    renderListings();
}

function renderListings() {
    if (!listingsGrid) return;
    listingsGrid.innerHTML = '';

    const filteredPhones = phoneData.filter(phone => {
        if (phone.status && phone.status !== 'Available') return false;
        const matchesBrand = (selectedBrand === 'all' || phone.brand === selectedBrand);
        const searchString = `${phone.brand || ''} ${phone.model || ''} ${phone.location || ''}`.toLowerCase();
        const matchesSearch = searchString.includes(searchQuery.toLowerCase());
        return matchesBrand && matchesSearch;
    });

    if (filteredPhones.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
    } else {
        if (emptyState) emptyState.style.display = 'none';
        filteredPhones.forEach(phone => {
            const card = document.createElement('div');
            
            card.style.cssText = `
                background: #ffffff;
                border-radius: 16px;
                border: 1px solid #e2e8f0;
                overflow: hidden;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
                transition: transform 0.3s ease, box-shadow 0.3s ease;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                cursor: pointer;
            `;

            // होवर इफेक्ट्स बाइंडिंग
            card.onmouseenter = () => {
                card.style.transform = 'translateY(-6px)';
                card.style.boxShadow = '0 12px 30px rgba(2, 36, 73, 0.1)';
            };
            card.onmouseleave = () => {
                card.style.transform = 'translateY(0)';
                card.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.05)';
            };

            // Image Handler System
            const phoneImages = Array.isArray(phone.images) && phone.images.length ? phone.images : (phone.image ? [phone.image] : []);
            const imageHtml = phoneImages.length
                ? `<div style="height:100%;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px"><img class="phone-main-image" src="${phoneImages[0]}" alt="${phone.brand || ''} ${phone.model || ''}" style="max-width:100%;max-height:155px;object-fit:contain">${phoneImages.length > 1 ? `<div style="display:flex;gap:5px;overflow:auto;max-width:100%">${phoneImages.map((src,index) => `<button type="button" class="phone-image-thumb" data-index="${index}" aria-label="View image ${index+1}" style="padding:2px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer"><img src="${src}" style="width:38px;height:38px;object-fit:cover"></button>`).join('')}</div>` : ''}</div>`
                : `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8;">
                    <span style="font-size: 2.5rem; font-weight: 800; color: #cbd5e1; letter-spacing: 1px;">PB</span>
                    <small style="font-size: 0.75rem; margin-top: 5px; color: #94a3b8;">Refurbished Stock</small>
                   </div>`;

            let itemPrice = phone.price || phone.expectedPrice || 0;
            const isFavorite = getFavoriteIds().includes(String(phone._id));

            card.innerHTML = `
                <!-- इमेज बॉक्स फ्रेम (6 Months Warranty Protection & Refurbished Tags) -->
                <div style="height: 220px; background-color: #f8fafc; display: flex; justify-content: center; align-items: center; overflow: hidden; padding: 20px; border-bottom: 1px solid #f1f5f9; position: relative;">
                    ${imageHtml}
                    <span style="position: absolute; top: 12px; left: 12px; background: #022449; color: white; font-size: 0.65rem; font-weight: 700; padding: 4px 10px; border-radius: 20px; letter-spacing: 0.5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                        🛡️ 6M PB WARRANTY
                    </span>
                    <span style="position: absolute; top: 12px; right: 12px; background: #d1aa4a; color: #022449; font-size: 0.65rem; font-weight: 800; padding: 4px 10px; border-radius: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                        🌟 REFURBISHED
                    </span>
                </div>

                <!-- इनफार्मेशन कंटेनर बॉक्स -->
                <div style="padding: 1.25rem; flex-grow: 1; display: flex; flex-direction: column; justify-content: space-between; gap: 10px;">
                    <div>
                        <!-- मॉडल का नाम -->
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><h3 style="font-size: 1.15rem; font-weight: 700; color: #0f172a; margin: 0 0 6px 0; text-transform: capitalize; line-height: 1.4;">${phone.model || 'Unknown Model'}</h3><button type="button" class="favorite-toggle" aria-label="${isFavorite ? 'Remove from saved phones' : 'Save this phone'}" aria-pressed="${isFavorite}" style="flex:none;border:1px solid #dce5ef;border-radius:50%;width:36px;height:36px;color:${isFavorite ? '#c43b52' : '#53657a'};background:#fff;font-size:1.2rem;cursor:pointer">${isFavorite ? '♥' : '♡'}</button></div>
                        
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;">
                            <span style="background: #eff6ff; color: #1e40af; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px;">
                                ⚙️ 32-Point Inspected
                            </span>
                            <span style="background: #f0fdf4; color: #166534; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px;">
                                ${phone.condition || 'Refurbished'}
                            </span>
                        </div>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 5px;">
                        <div style="display: flex; flex-direction: column;">
                            <span style="font-size: 0.8rem; color: #64748b; text-decoration: line-through; margin-bottom: -2px;">
                                ₹${Math.round(itemPrice * 1.45).toLocaleString('en-IN')}
                            </span>
                            <span style="font-size: 1.5rem; font-weight: 800; color: #0d9488; font-family: sans-serif;">
                                ₹${parseInt(itemPrice).toLocaleString('en-IN')}
                            </span>
                        </div>
                        <span style="font-size: 0.75rem; color: #1e293b; font-weight: 700; background: #f1f5f9; padding: 4px 10px; border-radius: 20px; border: 1px solid #cbd5e1;">
                            Free Delivery
                        </span>
                    </div>

                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;color:#53657a;font-size:.82rem;margin-top:2px;">
                        <span>📍 ${phone.location || 'Location not listed'}</span>
                        <span>${phoneImages.length} photo${phoneImages.length === 1 ? '' : 's'}</span>
                    </div>
                    <span class="listing-view-hint">View photos, condition &amp; defects →</span>

            <button class="buy-now-btn" data-model="${phone.model}" data-price="${itemPrice}" data-product-id="${phone._id || ''}" style="width: 100%; padding: 12px; background: #022449; color: #ffffff; border: none; border-radius: 10px; font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background 0.2s ease; margin-top: 10px; box-shadow: 0 4px 6px rgba(2, 36, 73, 0.15);">
                        ⚡ Buy From PhoneBandhu
                    </button>
                </div>
            `;

            card.querySelector('.buy-now-btn')?.insertAdjacentHTML('afterend', '<button type="button" class="add-to-cart-btn" style="width:100%;padding:10px;background:#fff;color:#082b50;border:1px solid #d2ad58;border-radius:10px;font-size:.88rem;font-weight:800;cursor:pointer;margin-top:7px">Add to cart</button>');
            card.querySelectorAll('.phone-image-thumb').forEach(button => button.addEventListener('click', () => {
                const mainImage = card.querySelector('.phone-main-image');
                if (mainImage) mainImage.src = phoneImages[Number(button.dataset.index)];
            }));
            card.querySelector('.favorite-toggle')?.addEventListener('click', event => { event.stopPropagation(); togglePhoneFavorite(phone); });
            card.querySelector('.add-to-cart-btn')?.addEventListener('click', event => { event.stopPropagation(); addPhoneToCart(phone); });
            card.addEventListener('click', event => {
                if (event.target.closest('button')) return;
                openPhoneDetails(phone);
            });
            card.tabIndex = 0;
            card.setAttribute('aria-label', `${phone.brand || ''} ${phone.model || 'Phone'} details, ₹${Number(itemPrice).toLocaleString('en-IN')}`);
            card.addEventListener('keydown', event => {
                if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    openPhoneDetails(phone);
                }
            });
            listingsGrid.appendChild(card);
        });
    }
    attachBuyEvents(); // Call purchase modal connector framework
}

function openPhoneDetails(phone) {
    const modal = document.getElementById('phoneDetailsModal');
    const content = document.getElementById('phoneDetailsContent');
    if (!modal || !content) return;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const images = Array.isArray(phone.images) && phone.images.length ? phone.images : (phone.image ? [phone.image] : []);
    const price = Number(phone.price || phone.expectedPrice || 0);
    const issues = phone.issues || {};
    const defectLabels = [
        ['screenBroken', 'Screen / front glass damage'], ['bodyDents', 'Body dents or physical marks'],
        ['batteryLow', 'Battery health below 80%'], ['cameraIssue', 'Camera or sensor issue'],
        ['missingBillBox', 'Original bill or box missing']
    ];
    const defects = defectLabels.filter(([key]) => issues[key]).map(([, label]) => label);
    const title = `${phone.brand || ''} ${phone.model || 'Phone'}`.trim();
    const heroImage = images[0] || '';
    content.innerHTML = `
        <div>
            <div class="phone-gallery-main">${heroImage ? `<img id="phoneDetailHero" src="${esc(heroImage)}" alt="${esc(title)} phone photo">` : '<div style="font-size:3rem;font-weight:900;color:#cbd5e1">PB</div>'}<span style="position:absolute;top:12px;left:12px;background:#082b50;color:#fff;padding:6px 10px;border-radius:20px;font-size:.72rem;font-weight:800">${images.length} PHOTOS</span></div>
            <div class="phone-gallery-thumbs" aria-label="Phone photos">${images.map((src,index) => `<button type="button" class="phone-gallery-thumb${index === 0 ? ' active' : ''}" data-photo-index="${index}" aria-label="Show photo ${index + 1}"><img src="${esc(src)}" alt=""></button>`).join('')}</div>
        </div>
        <div class="phone-detail-info">
            <div><small style="color:#a17c2e;font-weight:800;letter-spacing:.1em">PHONEBANDHU CERTIFIED</small><h2 id="phoneDetailTitle">${esc(title)}</h2></div>
            <div class="phone-detail-price">₹${price.toLocaleString('en-IN')}</div>
            <div class="phone-detail-meta">
                <div><small>Brand</small><strong>${esc(phone.brand || '—')}</strong></div>
                <div><small>Condition</small><strong>${esc(phone.condition || 'Refurbished')}</strong></div>
                <div><small>Location</small><strong>📍 ${esc(phone.location || 'Not listed')}</strong></div>
                <div><small>Delivery</small><strong>Free delivery</strong></div>
            </div>
            <div class="phone-defects"><h4>Condition &amp; reported defects</h4>${defects.length ? `<ul>${defects.map(defect => `<li>${esc(defect)}</li>`).join('')}</ul>` : '<p style="color:#53657a;font-size:.88rem">No defects reported by the seller.</p>'}</div>
            <p style="color:#64748b;font-size:.8rem">Photos are provided for this specific phone. Please review every image and the condition details before ordering.</p>
            <button type="button" class="buy-now-btn" data-model="${esc(phone.model || 'Phone')}" data-price="${price}" data-product-id="${esc(phone._id || '')}" style="width:100%;padding:13px;background:#082b50;color:#fff;border:0;border-radius:10px;font-size:1rem;font-weight:800;cursor:pointer">⚡ Buy from PhoneBandhu</button>
        </div>`;
    const saved = getFavoriteIds().includes(String(phone._id));
    content.querySelector('.buy-now-btn')?.insertAdjacentHTML('beforebegin', `<button type="button" class="detail-favorite" aria-pressed="${saved}" style="width:100%;padding:10px;background:#fff;border:1px solid #dce5ef;border-radius:10px;color:${saved ? '#c43b52' : '#082b50'};font-weight:800;cursor:pointer;margin-bottom:8px">${saved ? '♥ Saved to your account' : '♡ Save to my account'}</button>`);
    content.querySelector('.buy-now-btn')?.insertAdjacentHTML('afterend', '<button type="button" class="detail-add-cart" style="width:100%;padding:11px;background:#fff;color:#082b50;border:1px solid #d2ad58;border-radius:10px;font-weight:800;cursor:pointer;margin-top:8px">Add to cart</button>');
    content.querySelector('.detail-favorite')?.addEventListener('click', () => { togglePhoneFavorite(phone); modal.style.display = 'none'; });
    content.querySelector('.detail-add-cart')?.addEventListener('click', () => addPhoneToCart(phone));
    content.querySelectorAll('[data-photo-index]').forEach(button => button.addEventListener('click', () => {
        const hero = content.querySelector('#phoneDetailHero');
        if (hero) hero.src = images[Number(button.dataset.photoIndex)];
        content.querySelectorAll('.phone-gallery-thumb').forEach(thumb => thumb.classList.toggle('active', thumb === button));
    }));
    attachBuyEvents();
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
}

document.querySelector('[data-close-phone-details]')?.addEventListener('click', () => {
    const modal = document.getElementById('phoneDetailsModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
});
document.getElementById('phoneDetailsModal')?.addEventListener('click', event => {
    if (event.target.id === 'phoneDetailsModal') {
        event.currentTarget.style.display = 'none';
        event.currentTarget.setAttribute('aria-hidden', 'true');
    }
});
// 📦 Checkout Form Panel Activity Toggler Connector 
function attachBuyEvents() {
    document.querySelectorAll('.buy-now-btn').forEach(btn => {
        if (btn.dataset.checkoutBound === 'true') return;
        btn.dataset.checkoutBound = 'true';
        btn.addEventListener('click', () => {
            const currentUser = JSON.parse(localStorage.getItem('currentUser'));
            if (!currentUser) {
                alert("⚠️ ऑर्डर बुक करने के लिए कृपया पहले अपने अकाउंट में लॉगिन करें!");
                window.location.href = 'auth.html';
                return;
            }

            const model = btn.getAttribute('data-model');
            const price = btn.getAttribute('data-price');
            sessionStorage.removeItem('phoneBandhuCheckoutCart');
            sessionStorage.setItem('phoneBandhuCheckoutItem', JSON.stringify({
                model, price: Number(price),
                productId: btn.getAttribute('data-product-id') || ''
            }));
            window.location.href = 'buy-now.html';
        });
    });
}

document.getElementById('orderCheckoutForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    const productLabel = document.getElementById('checkoutProductTitle').innerText.replace('Item: ', '');
    const priceLabel = document.getElementById('checkoutProductPrice').innerText;
    let checkoutItem = {};
    try { checkoutItem = JSON.parse(sessionStorage.getItem('phoneBandhuCheckoutItem') || '{}'); } catch {}

    const orderPayload = {
        orderId: `PB-ORD-${Date.now()}`,
        productId: checkoutItem.productId || '',
        product: productLabel,
        price: priceLabel,
        customerName: document.getElementById('orderName').value,
        customerPhone: document.getElementById('orderPhone').value,
        address: document.getElementById('orderAddress').value,
        pincode: document.getElementById('orderPincode').value,
        customerEmail: JSON.parse(localStorage.getItem('currentUser'))?.email || '',
        status: "Order Placed (COD)"
    };

    let confirmedOrderId = orderPayload.orderId;
    try {
        const response = await fetch(`${API_ORIGIN}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });
        const savedOrder = await response.json();
        if (!response.ok) throw new Error(savedOrder.message || 'Order save failed');
        confirmedOrderId = savedOrder.orderId;
    } catch (error) {
        let currentOrders = [];
        try { currentOrders = JSON.parse(localStorage.getItem('phoneBandhuOrders')) || []; } catch {}
        currentOrders.push(orderPayload);
        localStorage.setItem('phoneBandhuOrders', JSON.stringify(currentOrders));
    }

    alert(`🎉 बधाई हो! आपका ऑर्डर सफल रहा!\nआपका Order ID: ${confirmedOrderId}\nहमारी टीम वेरिफिकेशन के लिए जल्द ही आपसे संपर्क करेगी।`);
    
    document.getElementById('orderCheckoutForm').reset();
    document.getElementById('checkoutModal').style.display = 'none';
});

// --- इमेज टू Base64 कनवर्टर ---
function convertToBase64(file) {
    return new Promise((resolve) => {
        const fileReader = new FileReader();
        fileReader.readAsDataURL(file);
        fileReader.onload = () => resolve(fileReader.result);
        fileReader.onerror = () => resolve("");
    });
}

// --- 2. नया फोन सबमिट करने का फंक्शन (POST) ---
if (form) {
    form.addEventListener('submit', async event => {
        event.preventDefault();
        let currentUser=null;
        try { currentUser=JSON.parse(localStorage.getItem('currentUser')||'null'); } catch {}
        if(!currentUser){alert('Please log in before requesting a phone pickup.');window.location.href='auth.html';return;}
        const files=[...document.getElementById('phoneImage').files];
        if(files.length<1||files.length>6||files.some(file=>!file.type.startsWith('image/')||file.size>1024*1024)){
            alert('Please add 1 to 6 phone photos, each up to 1 MB.');return;
        }
        const submitButton=form.querySelector('[type="submit"]');
        submitButton.disabled=true;submitButton.textContent='Submitting pickup request...';
        try {
            const images=await Promise.all(files.map(convertToBase64));
            const issueAnswers=Object.fromEntries(Object.entries(ISSUE_FIELD_MAP).map(([id,key])=>[key,Boolean(document.getElementById(id).checked)]));
            const ageLabels=['Less than 6 months','6-12 months','1-2 years','2-3 years','3-4 years','More than 4 years'];
            const age=ageLabels[Number(document.getElementById('phoneAge').value)]||'';
            const payload={
                brand:document.getElementById('phoneBrand').value,
                model:document.getElementById('phoneModel').value==='__other__'?document.getElementById('phoneCustomModel').value.trim():document.getElementById('phoneModel').value,
                price:Number(document.getElementById('expectedPrice').value),
                expectedPrice:Number(document.getElementById('expectedPrice').value),
                location:document.getElementById('phoneLocation').value.trim(),
                condition:age+' / '+document.getElementById('phoneStorage').value+' / '+(Object.values(issueAnswers).some(Boolean)?'Issues disclosed':'No issues disclosed'),
                age, storage:document.getElementById('phoneStorage').value,
                image:images[0],images,issues:issueAnswers,
                sellerEmail:currentUser.email,sellerName:document.getElementById('sellerName').value.trim(),
                sellerPhone:document.getElementById('sellerPhone').value.trim(),
                sellerPincode:document.getElementById('sellerPincode').value.trim(),
                pickupAddress:document.getElementById('sellerAddress').value.trim(),
                status:'Pending Valuation Approval'
            };
            const response=await fetch(API_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            const result=await response.json();
            if(!response.ok)throw new Error(result.message||'Could not submit your pickup request.');
            const localList=JSON.parse(localStorage.getItem('phoneListings')||'[]');
            localList.push({...payload,id:result._id||Date.now()});
            localStorage.setItem('phoneListings',JSON.stringify(localList));
            alert('Your PhoneBandhu pickup request is submitted. The team will contact you to confirm the inspection and final offer.');
            form.reset();document.getElementById('sellPhotoPreviews').replaceChildren();
            document.getElementById('suggestedPriceDisplay').textContent='Select a model';
            if(modal)modal.style.display='none';
            await fetchPhonesFromBackend();
        } catch(error) {
            alert(error.message||'Could not submit the request. Check the backend connection and try again.');
        } finally {submitButton.disabled=false;submitButton.textContent='Get my estimate & request pickup';}
    });
}

if (searchInput) {
    searchInput.addEventListener('input', (e) => { searchQuery = e.target.value; renderListings(); });
}

// ब्रांड चिप्स फ़िल्टर लॉजिक मैनेजमेंट
brandChips.forEach(chip => {
    chip.addEventListener('click', (e) => {
        brandChips.forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        selectedBrand = e.target.getAttribute('data-brand');
        renderListings();
    });
});

if (heroBrowseBtn) {
    heroBrowseBtn.addEventListener('click', () => {
        document.getElementById('marketplaceView')?.scrollIntoView({ behavior: 'smooth' });
    });
}

// Load marketplace data only on pages that contain the listings grid.
if (listingsGrid) {
    document.addEventListener('DOMContentLoaded', fetchPhonesFromBackend);
}
