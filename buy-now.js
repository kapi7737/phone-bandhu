const API_ORIGIN = window.location.protocol === 'file:' ? 'http://localhost:5200' : window.location.port === '5500' ? `${window.location.protocol}//${window.location.hostname}:5200` : window.location.origin;
const API = `${API_ORIGIN}/api`;
const form = document.getElementById('checkoutForm');
const message = document.getElementById('message');
const submit = document.getElementById('submitBtn');
const singleItem = (() => { try { return JSON.parse(sessionStorage.getItem('phoneBandhuCheckoutItem') || 'null'); } catch { return null; } })();
const cartItems = (() => { try { return JSON.parse(sessionStorage.getItem('phoneBandhuCheckoutCart') || '[]'); } catch { return []; } })();
const checkoutItems = cartItems.length ? cartItems : (singleItem ? [singleItem] : []);
const item = checkoutItems[0] || null;
const checkoutTotal = checkoutItems.reduce((sum, product) => sum + Number(product.price || 0), 0);
const user = (() => { try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { return null; } })();
const rupees = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;

if (!item || !item.model || !Number(item.price)) {
  document.getElementById('productName').textContent = 'No phone selected';
  submit.disabled = true;
  message.textContent = 'Please return to the shop and choose a phone first.';
} else {
  document.getElementById('productName').textContent = checkoutItems.length === 1 ? item.model : `${checkoutItems.length} phones in your cart`;
  document.getElementById('itemPrice').textContent = rupees(checkoutTotal);
  document.getElementById('totalPrice').textContent = rupees(checkoutTotal);
  document.querySelector('.summary-head span').textContent = `${checkoutItems.length} item${checkoutItems.length === 1 ? '' : 's'}`;
}

if (!user) {
  message.textContent = 'Please log in to place your order.';
  submit.textContent = 'Log in to continue →';
  submit.addEventListener('click', event => { event.preventDefault(); location.href = 'auth.html'; });
} else {
  document.getElementById('name').value = user.name || '';
  document.getElementById('phone').value = user.phone || '';
}

document.querySelectorAll('input[name="paymentMethod"]').forEach(radio => radio.addEventListener('change', () => {
  document.querySelectorAll('.method').forEach(label => label.classList.toggle('selected', label.querySelector('input').checked));
  submit.innerHTML = radio.value === 'online' ? 'Continue to payment <span>→</span>' : 'Place cash on delivery order <span>→</span>';
}));

async function jsonRequest(url, body) {
  const response = await fetch(`${API}${url}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Could not complete your request.');
  return data;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!user) { location.href = 'auth.html'; return; }
  if (!item) return;
  message.textContent = '';
  submit.disabled = true;
  const originalText = submit.textContent;
  submit.textContent = 'Please wait…';
  const delivery = { customerName: document.getElementById('name').value.trim(), customerPhone: document.getElementById('phone').value, address: document.getElementById('address').value.trim(), pincode: document.getElementById('pincode').value, customerEmail: user.email || '' };
  try {
    const method = new FormData(form).get('paymentMethod');
    if (method === 'cod') {
      const order = await jsonRequest('/orders', { ...delivery, ...(checkoutItems.length > 1 ? { productIds: checkoutItems.map(product => product.productId) } : { productId: item.productId }) });
      sessionStorage.removeItem('phoneBandhuCheckoutCart');
      sessionStorage.removeItem('phoneBandhuCheckoutItem');
      if (cartItems.length) localStorage.removeItem(`phoneBandhu_cart_${encodeURIComponent(String(user.email || 'guest').trim().toLowerCase())}`);
      alert(`Order placed! ${order.orderIds?.length || 1} PhoneBandhu order${(order.orderIds?.length || 1) === 1 ? '' : 's'} saved. First order ID: ${order.orderId || 'saved'}.`);
      location.href = 'index.html';
      return;
    }
    if (!item.productId) throw new Error('Online payment is available for verified catalogue items only. Please choose Cash on delivery or contact support.');
    const created = await jsonRequest('/payments/create-order', { productId: item.productId, ...delivery });
    const checkout = new Razorpay({ key: created.keyId, amount: created.amount, currency: created.currency, name: 'PhoneBandhu', description: item.model, order_id: created.gatewayOrderId, prefill: { name: delivery.customerName, email: delivery.customerEmail, contact: delivery.customerPhone }, theme: { color: '#082b50' }, handler: async result => {
      try {
        const confirmation = await jsonRequest('/payments/verify', { ...result, internalOrderId: created.orderId, ...delivery });
        sessionStorage.removeItem('phoneBandhuCheckoutCart');
        sessionStorage.removeItem('phoneBandhuCheckoutItem');
        if (cartItems.length) localStorage.removeItem(`phoneBandhu_cart_${encodeURIComponent(String(user.email || 'guest').trim().toLowerCase())}`);
        alert(`Payment successful! Your PhoneBandhu order ID is ${confirmation.orderId}.`);
        location.href = 'index.html';
      } catch (error) { message.textContent = `${error.message} Please contact support with your payment reference.`; submit.disabled = false; submit.textContent = originalText; }
    }, modal: { ondismiss: () => { submit.disabled = false; submit.textContent = originalText; } } });
    checkout.on('payment.failed', failure => { message.textContent = failure.error?.description || 'Payment could not be completed. Please try again.'; submit.disabled = false; submit.textContent = originalText; });
    checkout.open();
  } catch (error) { message.textContent = error.message; submit.disabled = false; submit.textContent = originalText; }
});

fetch(`${API}/payments/config`).then(response => response.json()).then(config => {
  if (checkoutItems.length > 1) {
    document.querySelector('input[value="online"]').disabled = true;
    document.querySelector('input[value="cod"]').checked = true;
    document.querySelector('.method').classList.remove('selected');
    document.querySelectorAll('.method')[1].classList.add('selected');
    document.getElementById('gatewayNote').hidden = false;
    document.getElementById('gatewayNote').textContent = 'Cart checkout currently supports Cash on delivery for multiple phones.';
    submit.innerHTML = 'Place cash on delivery orders <span>→</span>';
  }
  if (!config.onlineEnabled) {
    document.querySelector('input[value="online"]').disabled = true;
    document.querySelector('input[value="cod"]').checked = true;
    document.querySelector('.method').classList.remove('selected');
    document.querySelectorAll('.method')[1].classList.add('selected');
    document.getElementById('gatewayNote').hidden = false;
    submit.innerHTML = 'Place cash on delivery order <span>→</span>';
  }
}).catch(() => {});
