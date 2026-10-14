const ADMIN_API_ORIGIN = location.protocol === 'file:' ? 'http://localhost:5200' : location.port === '5500' ? `${location.protocol}//${location.hostname}:5200` : location.origin;
const ADMIN_API = `${ADMIN_API_ORIGIN}/api`;
let currentAdminRole = 'admin';

async function adminFetchJson(url, options) {
    const response = await fetch(url, { credentials: 'include', ...options });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error(response.status === 404 ? 'Admin API route missing. Restart the backend server and refresh this page.' : 'Backend returned an HTML error page. Confirm the backend is running on port 5200.');
    }
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401 && !/\/admin\/(login|session)$/.test(url)) showAdminLogin('Your administrator session has expired. Please sign in again.');
        throw new Error(data.message || `Backend error (${response.status}).`);
    }
    return data;
}

document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('main.admin-wrapper').hidden = true;
    document.getElementById('adminLoginPanel').hidden = false;
    document.getElementById('adminLoginForm')?.addEventListener('submit', submitAdminLogin);
    document.getElementById('adminLogoutBtn')?.addEventListener('click', signOutAdmin);
    document.getElementById('createAdminForm')?.addEventListener('submit', createManagedAdmin);
    const form = document.getElementById('adminPhoneForm');
    if (form) {
        const inventory = document.getElementById('adminPhonesTable')?.closest('.data-section');
        if (inventory) inventory.insertBefore(form, inventory.querySelector('div[style*="overflow-x"]'));
        form.addEventListener('submit', submitAdminPhone);
        const input = document.getElementById('adminPhoneImages');
        const dropzone = document.getElementById('adminImageDropzone');
        if (input && dropzone) {
            input.addEventListener('change', () => renderAdminImagePreview(input.files));
            ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
            ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); }));
            dropzone.addEventListener('drop', event => {
                const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
                if (!files.length) return;
                const transfer = new DataTransfer();
                files.forEach(file => transfer.items.add(file));
                input.files = transfer.files;
                renderAdminImagePreview(input.files);
            });
        }
    }
    refreshBackendStatus();
    setInterval(refreshBackendStatus, 10000);
    checkAdminSession();
});

function showAdminLogin(message = '') {
    document.querySelector('main.admin-wrapper').hidden = true;
    document.getElementById('adminLoginPanel').hidden = false;
    document.getElementById('adminLogoutBtn').hidden = true;
    document.getElementById('adminLoginMessage').textContent = message;
}

async function checkAdminSession() {
    try {
        const session = await adminFetchJson(`${ADMIN_API}/admin/session`);
        currentAdminRole = session.role;
        document.getElementById('adminLoginPanel').hidden = true;
        document.querySelector('main.admin-wrapper').hidden = false;
        document.getElementById('adminLogoutBtn').hidden = false;
        const masterTools = document.getElementById('masterAdminTools');
        if (masterTools) masterTools.hidden = currentAdminRole !== 'master';
        await loadAdminDashboard();
    } catch (error) {
        showAdminLogin(error.message.includes('locked') || error.message.includes('Database') ? error.message : 'Sign in with the administrator credentials configured in backend/.env.');
    }
}

async function submitAdminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const message = document.getElementById('adminLoginMessage');
    button.disabled = true;
    message.textContent = '';
    try {
        await adminFetchJson(`${ADMIN_API}/admin/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: document.getElementById('adminLoginEmail').value.trim(), password: document.getElementById('adminLoginPassword').value })
        });
        form.reset();
        await checkAdminSession();
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
}

async function signOutAdmin() {
    try { await adminFetchJson(`${ADMIN_API}/admin/logout`, { method: 'POST' }); }
    catch {}
    showAdminLogin('You have signed out.');
}

let adminPreviewUrls = [];
function renderAdminImagePreview(fileList) {
    const preview = document.getElementById('adminImagePreview');
    const dropzone = document.getElementById('adminImageDropzone');
    if (!preview) return;
    adminPreviewUrls.forEach(url => URL.revokeObjectURL(url));
    adminPreviewUrls = [];
    const files = [...(fileList || [])];
    preview.innerHTML = '';
    const hint = dropzone?.querySelector('span');
    if (hint) hint.textContent = files.length ? `${files.length} photo${files.length === 1 ? '' : 's'} selected` : 'Drop images here or click to choose multiple files';
    files.forEach(file => {
        const tile = document.createElement('div');
        tile.className = 'admin-image-tile';
        const image = document.createElement('img');
        const url = URL.createObjectURL(file);
        adminPreviewUrls.push(url);
        image.src = url;
        image.alt = file.name;
        const name = document.createElement('span');
        name.textContent = file.name;
        tile.append(image, name);
        preview.appendChild(tile);
    });
}

async function refreshBackendStatus() {
    let banner = document.getElementById('backendStatusBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'backendStatusBanner';
        banner.style.cssText = 'margin:12px auto;padding:10px 14px;max-width:1120px;border-radius:8px;font-weight:600';
        document.querySelector('main.admin-wrapper')?.prepend(banner);
    }
    try {
        const health = await adminFetchJson(`${ADMIN_API}/health`);
        if (health.database === 'connected') {
            banner.textContent = 'PhoneBandhu backend :5200 connected | Database connected';
            banner.style.cssText += ';background:#dcfce7;color:#166534';
        } else {
            const detail = health.databaseError || (health.database === 'connecting' ? 'Waiting for the database connection attempt to finish.' : 'No connection error details are available yet.');
            let nextStep = 'The server will retry automatically.';
            if (health.databaseIssue === 'dns' || /querySrv.*ETIMEOUT|querySrv.*ETIMEDOUT/i.test(detail)) nextStep = 'This computer cannot complete the MongoDB Atlas DNS lookup. Check its DNS/internet connection and the MONGO_URI host in backend/.env. The server retries automatically.';
            else if (health.databaseIssue === 'network-access' || /MongoServerSelectionError|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(detail)) nextStep = 'Check Atlas Network Access for this computer current IP, confirm the cluster is running, and check the internet connection. The server retries automatically.';
            else if (health.databaseIssue === 'auth' || /Authentication failed|bad auth|MongoServerError/i.test(detail)) nextStep = 'Check the database username/password and database user permissions in backend/.env, then restart the backend.';
            banner.textContent = `PhoneBandhu backend :5200 online | Database ${health.database}. ${detail} ${nextStep}`;
            banner.style.cssText += ';background:#fef3c7;color:#92400e';
        }
    } catch (error) {
        banner.textContent = `Backend connection failed: ${error.message}`;
        banner.style.cssText += ';background:#fee2e2;color:#991b1b';
    }
}

function adminEscape(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function adminSafeImage(value) {
    const raw = String(value || '');
    if (/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(raw)) return raw;
    try {
        const url = new URL(raw, location.origin);
        return url.protocol === 'https:' || url.origin === location.origin ? url.href : '';
    } catch { return ''; }
}

function imageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

async function submitAdminPhone(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const files = [...form.elements.images.files];
    if (!files.length || files.length > 6 || files.some(file => file.size > 1024 * 1024)) {
        alert('Select 1–6 images, each no larger than 1 MB.');
        return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    try {
        const result = await adminFetchJson(`${ADMIN_API}/admin/phones`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand: values.brand, model: values.model, price: values.price, location: values.location, condition: values.condition, images: await Promise.all(files.map(imageAsDataUrl)) })
        });
        form.reset();
        await loadAdminDashboard();
        alert('Phone added to the live catalog.');
    } catch (error) { alert(error.message || 'Backend connection failed. Start the backend and try again.'); }
}

async function loadAdminDashboard() {
    const [phonesResult, usersResult, ordersResult] = await Promise.allSettled([
        adminFetchJson(`${ADMIN_API}/admin/phones`),
        adminFetchJson(`${ADMIN_API}/admin/users`),
        adminFetchJson(`${ADMIN_API}/admin/orders`)
    ]);
    const phonesTable = document.getElementById('adminPhonesTable');
    const buybacksTable = document.getElementById('adminBuybackRequestsTable');
    if (phonesResult.status === 'fulfilled') {
        const allPhones = phonesResult.value;
        const buybackRequests = allPhones.filter(phone => phone.sellerPhone && phone.status !== 'Available');
        const phones = allPhones.filter(phone => !phone.sellerPhone || phone.status === 'Available');
        document.getElementById('countPhones').textContent = phones.length;
        document.getElementById('countBuybacks').textContent = buybackRequests.length;
        phonesTable.innerHTML = phones.length ? '' : '<tr><td colspan="6">No catalog stock listed yet.</td></tr>';
        phones.forEach(phone => {
            const images = (phone.images?.length ? phone.images : (phone.image ? [phone.image] : [])).map(adminSafeImage).filter(Boolean);
            const row = document.createElement('tr');
            row.innerHTML = `<td>${images.length} image${images.length === 1 ? '' : 's'}</td><td><b>${adminEscape(phone.model)}</b><br><small>${adminEscape(phone.condition || '')}</small></td><td>${adminEscape(phone.brand)}</td><td>₹${Number(phone.price || phone.expectedPrice || 0).toLocaleString('en-IN')}</td><td>${adminEscape(phone.status || 'Available')}</td><td><button class="btn-delete">Remove</button></td>`;
            row.querySelector('button').addEventListener('click', () => deletePhoneFromCatalog(phone._id));
            phonesTable.appendChild(row);
        });
        buybacksTable.innerHTML = buybackRequests.length ? '' : '<tr><td colspan="7">No buyback requests awaiting inspection.</td></tr>';
        buybackRequests.forEach(phone => {
            const images = (phone.images?.length ? phone.images : (phone.image ? [phone.image] : [])).map(adminSafeImage).filter(Boolean);
            const gallery = images.length ? `<details><summary>View ${images.length} photo${images.length === 1 ? '' : 's'}</summary><div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">${images.map((src,index) => `<a href="${adminEscape(src)}" target="_blank" rel="noopener"><img src="${adminEscape(src)}" alt="${adminEscape(phone.model)} photo ${index + 1}" style="width:82px;height:82px;object-fit:cover;border-radius:7px;border:1px solid #dce5ef"></a>`).join('')}</div></details>` : 'No photos';
            const issues = Object.entries(phone.issues || {}).filter(([, value]) => value).map(([key]) => key.replace(/([A-Z])/g, ' $1').toLowerCase());
            const issueText = issues.length ? issues.join(', ') : 'No issues reported';
            const row = document.createElement('tr');
            const offerPrice = Number(phone.offerPrice || 0);
            const priceDisplay = offerPrice > 0
                ? `<strong>Final offer: ₹${offerPrice.toLocaleString('en-IN')}</strong>`
                : Number(phone.price || 0) > 0 ? `Indicative estimate: ₹${Number(phone.price).toLocaleString('en-IN')}` : '<b>Manual valuation needed</b>';
            const nextAction = phone.status === 'Pending Valuation Approval'
                ? '<button class="btn-approve" data-action="inspect">Start inspection</button>'
                : phone.status === 'Inspection In Progress'
                    ? '<button class="btn-approve" data-action="offer">Record final offer</button>'
                    : phone.status === 'Offer Accepted'
                        ? '<button class="btn-approve" data-action="received">Confirm received &amp; paid</button>'
                        : '';
            row.innerHTML = `<td><b>${adminEscape(phone.brand)} ${adminEscape(phone.model)}</b><br><small>${adminEscape(phone.storage || '')} · ${adminEscape(phone.age || '')}</small></td><td><strong style="color:#0d9488">${priceDisplay}</strong></td><td>${gallery}</td><td><b>${adminEscape(phone.sellerName || 'Seller')}</b><br><a href="tel:${adminEscape(phone.sellerPhone)}">${adminEscape(phone.sellerPhone)}</a><br><a href="mailto:${adminEscape(phone.sellerEmail)}">${adminEscape(phone.sellerEmail)}</a></td><td>${adminEscape(phone.location)} · <b>${adminEscape(phone.sellerPincode)}</b><br><small>${adminEscape(phone.pickupAddress)}</small></td><td>${adminEscape(issueText)}</td><td><b>${adminEscape(phone.status || 'Pending Valuation Approval')}</b><br>${nextAction ? `${nextAction}<br>` : ''}<button class="btn-delete" data-action="remove" style="margin-top:6px">Remove request</button></td>`;
            row.querySelector('[data-action="inspect"]')?.addEventListener('click', () => updateBuybackStatus(phone, 'start_inspection'));
            row.querySelector('[data-action="offer"]')?.addEventListener('click', () => sendBuybackOffer(phone));
            row.querySelector('[data-action="received"]')?.addEventListener('click', () => updateBuybackStatus(phone, 'confirm_received_paid'));
            row.querySelector('[data-action="remove"]').addEventListener('click', () => deletePhoneFromCatalog(phone._id));
            buybacksTable.appendChild(row);
        });
    } else {
        phonesTable.innerHTML = `<tr><td colspan="6">${adminEscape(phonesResult.reason?.message || 'Could not load phones.')}</td></tr>`;
        buybacksTable.innerHTML = `<tr><td colspan="7">${adminEscape(phonesResult.reason?.message || 'Could not load buyback requests.')}</td></tr>`;
    }

    const usersTable = document.getElementById('adminUsersTable');
    if (usersResult.status === 'fulfilled') {
        const users = usersResult.value;
        document.getElementById('countUsers').textContent = users.length;
        usersTable.innerHTML = users.length ? '' : '<tr><td colspan="5">No registered users found.</td></tr>';
        users.forEach(user => {
            const row = document.createElement('tr');
            row.innerHTML = `<td><b>${adminEscape(user.name)}</b></td><td>${adminEscape(user.email)}</td><td><code>${adminEscape(user.phoneBandhuId)}</code></td><td>${adminEscape(user.phone)}</td><td><button class="btn-delete">Remove User</button></td>`;
            row.querySelector('button').addEventListener('click', () => deleteUserFromDatabase(user._id));
            usersTable.appendChild(row);
        });
    } else usersTable.innerHTML = `<tr><td colspan="5">${adminEscape(usersResult.reason?.message || 'Could not load users.')}</td></tr>`;
    const ordersTable = document.getElementById('adminOrdersTable');
    const deliveredTable = document.getElementById('adminDeliveredOrdersTable');
    if (ordersResult.status === 'fulfilled') {
        const orders = ordersResult.value;
        const activeOrders = orders.filter(order => order.status !== 'Delivered');
        const deliveredOrders = orders.filter(order => order.status === 'Delivered');
        document.getElementById('countOrders').textContent = orders.length;
        ordersTable.innerHTML = activeOrders.length ? '' : '<tr><td colspan="5">No incoming orders.</td></tr>';
        activeOrders.forEach(order => {
            const row = document.createElement('tr');
            row.innerHTML = `<td><small>${adminEscape(order.orderId)}</small></td><td><b>${adminEscape(order.product)}</b><br><strong style="color:#0d9488">${adminEscape(order.price)}</strong></td><td>${adminEscape(order.customerName)}<br>${adminEscape(order.customerPhone)}<br>${adminEscape(order.customerEmail)}</td><td>${adminEscape(order.address)} - <b>${adminEscape(order.pincode)}</b><br><small>${adminEscape(order.status)}</small></td><td><button class="btn-approve" data-action="dispatch">Dispatch</button><button class="btn-approve" data-action="delivered" style="margin-top:4px">Mark Delivered</button><button class="btn-delete" data-action="cancel" style="margin-top:4px">Cancel</button></td>`;
            row.querySelector('[data-action="dispatch"]')?.addEventListener('click', () => updateOrderStatus(order.orderId, 'Shipped (In Transit)'));
            row.querySelector('[data-action="delivered"]')?.addEventListener('click', () => updateOrderStatus(order.orderId, 'Delivered'));
            row.querySelector('[data-action="cancel"]').addEventListener('click', () => updateOrderStatus(order.orderId, 'Cancelled'));
            if (['Cancelled', 'Shipped (In Transit)', 'Payment Successful'].includes(order.status)) row.querySelector('[data-action="dispatch"]').disabled = true;
            if (order.status === 'Cancelled') row.querySelector('[data-action="delivered"]').disabled = true;
            if (order.status === 'Cancelled') row.querySelector('[data-action="cancel"]').disabled = true;
            ordersTable.appendChild(row);
        });
        deliveredTable.innerHTML = deliveredOrders.length ? '' : '<tr><td colspan="5">No delivered orders yet.</td></tr>';
        deliveredOrders.forEach(order => {
            const row = document.createElement('tr');
            row.innerHTML = `<td><small>${adminEscape(order.orderId)}</small></td><td><b>${adminEscape(order.product)}</b><br>${adminEscape(order.price)}</td><td>${adminEscape(order.customerName)}<br>${adminEscape(order.customerPhone)}</td><td>${adminEscape(order.address)} - ${adminEscape(order.pincode)}</td><td><strong style="color:#059669">Delivered</strong></td>`;
            deliveredTable.appendChild(row);
        });
    } else {
        document.getElementById('countOrders').textContent = '—';
        ordersTable.innerHTML = `<tr><td colspan="5">${adminEscape(ordersResult.reason?.message || 'Could not load orders.')}</td></tr>`;
        deliveredTable.innerHTML = `<tr><td colspan="5">${adminEscape(ordersResult.reason?.message || 'Could not load delivered orders.')}</td></tr>`;
    }

    const masterTools = document.getElementById('masterAdminTools');
    if (currentAdminRole === 'master' && masterTools && !masterTools.hidden) await loadMasterAdminTools();
}

async function loadMasterAdminTools() {
    const [adminsResult, auditResult] = await Promise.allSettled([
        adminFetchJson(`${ADMIN_API}/admin/admins`),
        adminFetchJson(`${ADMIN_API}/admin/audit`)
    ]);
    const adminsTable = document.getElementById('managedAdminsTable');
    if (adminsResult.status === 'fulfilled') {
        const admins = adminsResult.value;
        adminsTable.innerHTML = admins.length ? '' : '<tr><td colspan="5">No additional admin accounts yet.</td></tr>';
        admins.forEach(admin => {
            const row = document.createElement('tr');
            const actionButtons = `<a class="btn-approve" style="display:inline-block;text-decoration:none" href="admin-password-reset.html?admin=${encodeURIComponent(admin._id)}">Reset password</a> ` + (admin.status === 'pending'
                ? '<button class="btn-approve" data-status="approved">Approve</button><button class="btn-delete" data-status="rejected">Reject</button>'
                : admin.status === 'approved'
                    ? '<button class="btn-delete" data-status="disabled">Disable</button>'
                    : '<button class="btn-approve" data-status="approved">Approve</button>');
            row.innerHTML = `<td>${adminEscape(admin.email)}</td><td>${adminEscape(admin.status)}</td><td>${adminEscape(new Date(admin.createdAt).toLocaleString())}</td><td>${adminEscape(admin.approvedBy || '—')}</td><td>${actionButtons}</td>`;
            row.querySelectorAll('[data-status]').forEach(button => button.addEventListener('click', () => updateManagedAdminStatus(admin._id, button.dataset.status)));
            adminsTable.appendChild(row);
        });
    } else adminsTable.innerHTML = `<tr><td colspan="5">${adminEscape(adminsResult.reason?.message || 'Could not load admins.')}</td></tr>`;

    const auditTable = document.getElementById('adminAuditTable');
    if (auditResult.status === 'fulfilled') {
        const logs = auditResult.value;
        auditTable.innerHTML = logs.length ? '' : '<tr><td colspan="5">No admin changes recorded yet.</td></tr>';
        logs.forEach(log => {
            const row = document.createElement('tr');
            row.innerHTML = `<td>${adminEscape(new Date(log.createdAt).toLocaleString())}</td><td><b>${adminEscape(log.actorEmail)}</b><br><small>${adminEscape(log.actorRole)}</small></td><td>${adminEscape(log.action)}</td><td>${adminEscape(log.targetType)}<br><small>${adminEscape(log.targetId)}</small></td><td>${adminEscape(JSON.stringify(log.details || {}))}</td>`;
            auditTable.appendChild(row);
        });
    } else auditTable.innerHTML = `<tr><td colspan="5">${adminEscape(auditResult.reason?.message || 'Could not load audit logs.')}</td></tr>`;
}

async function createManagedAdmin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = document.getElementById('adminManagementMessage');
    try {
        const result = await adminFetchJson(`${ADMIN_API}/admin/admins`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: document.getElementById('newAdminEmail').value.trim(), password: document.getElementById('newAdminPassword').value })
        });
        form.reset();
        message.textContent = result.message;
        await loadMasterAdminTools();
    } catch (error) { message.textContent = error.message; }
}

async function updateManagedAdminStatus(id, status) {
    try {
        await adminFetchJson(`${ADMIN_API}/admin/admins/${encodeURIComponent(id)}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        await loadMasterAdminTools();
    } catch (error) { alert(error.message); }
}

async function updateOrderStatus(orderId, status) {
    try {
        await adminFetchJson(`${ADMIN_API}/admin/orders/${encodeURIComponent(orderId)}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
        await loadAdminDashboard();
    } catch (error) { alert(error.message); }
}

async function deletePhoneFromCatalog(id) {
    if (!confirm('Remove this phone from the catalog?')) return;
    try { await adminFetchJson(`${ADMIN_API}/admin/phones/${id}`, { method: 'DELETE' }); loadAdminDashboard(); }
    catch (error) { alert(error.message); }
}

async function updateBuybackStatus(phone, action, price) {
    if (action === 'confirm_received_paid' && !confirm('Confirm karein ki phone PhoneBandhu ko mil chuka hai aur seller ko payment bhej di gayi hai? Iske baad listing website par live hogi.')) return;
    try {
        await adminFetchJson(`${ADMIN_API}/admin/phones/${encodeURIComponent(phone._id)}/buyback`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, price })
        });
        await loadAdminDashboard();
    } catch (error) { alert(error.message); }
}

async function sendBuybackOffer(phone) {
    const initial = Number(phone.price || 0);
    const entered = prompt('Inspection ke baad seller ko dene wala final offer (₹) enter karein:', initial > 0 ? String(initial) : '');
    if (entered === null) return;
    const price = Number(entered);
    if (!Number.isFinite(price) || price <= 0 || price > 1000000) return alert('Offer ₹1 se ₹10,00,000 ke beech hona chahiye.');
    if (!confirm(`₹${price.toLocaleString('en-IN')} ka final offer seller ke account mein record karein? Offer record karne ke baad seller ko contact karke batayein.`)) return;
    await updateBuybackStatus(phone, 'send_offer', price);
}

async function deleteUserFromDatabase(id) {
    if (!confirm('Remove this registered user?')) return;
    try { await adminFetchJson(`${ADMIN_API}/admin/users/${id}`, { method: 'DELETE' }); loadAdminDashboard(); }
    catch (error) { alert(error.message); }
}
