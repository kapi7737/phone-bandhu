const CART_API = `${location.protocol === 'file:' || location.port === '5500' ? 'http://localhost:5200' : location.origin}/api`;
const cartUser = (() => { try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); } catch { return null; } })();
const cartKey = `phoneBandhu_cart_${encodeURIComponent(String(cartUser?.email || 'guest').trim().toLowerCase())}`;
const currency = value => `${String.fromCharCode(8377)}${Number(value || 0).toLocaleString('en-IN')}`;
const escapeCart = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cartListings = [];

function readCartIds() { try { const value = JSON.parse(localStorage.getItem(cartKey) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
function saveCartIds(ids) { localStorage.setItem(cartKey, JSON.stringify(ids)); }
function renderCart() {
  const container = document.getElementById('cartItems');
  const ids = readCartIds();
  cartListings = cartListings.filter(phone => ids.includes(String(phone._id)));
  const validIds = cartListings.map(phone => String(phone._id));
  if (validIds.length !== ids.length) saveCartIds(validIds);
  document.getElementById('cartItemCount').textContent = cartListings.length;
  document.getElementById('cartTotal').textContent = currency(cartListings.reduce((sum, phone) => sum + Number(phone.price || 0), 0));
  const checkout = document.getElementById('checkoutCart');
  checkout.disabled = cartListings.length === 0;
  if (!cartListings.length) {
    container.innerHTML = '<div class="empty"><b>Your cart is waiting for a phone</b><p>Add a listing from the shop and it will appear here.</p><a href="index.html#marketplaceView">Explore phones</a></div>';
    return;
  }
  container.innerHTML = cartListings.map(phone => {
    const image = phone.images?.[0] || phone.image || 'logo.png.jpg';
    return `<article class="item"><img src="${escapeCart(image)}" alt="${escapeCart(phone.model)}"><div><h2>${escapeCart(phone.brand)} ${escapeCart(phone.model)}</h2><p>${escapeCart(phone.location || 'India')} · ${escapeCart(phone.condition || 'Refurbished')}</p><span class="price">${currency(phone.price)}</span></div><button type="button" class="remove" data-remove-id="${escapeCart(phone._id)}">Remove</button></article>`;
  }).join('');
  container.querySelectorAll('[data-remove-id]').forEach(button => button.addEventListener('click', () => {
    saveCartIds(readCartIds().filter(id => id !== button.dataset.removeId));
    renderCart();
  }));
}

async function loadCart() {
  const container = document.getElementById('cartItems');
  try {
    const response = await fetch(`${CART_API}/phones`);
    if (!response.ok) throw new Error('Could not load the phone catalog. Please try again.');
    const phones = await response.json();
    const ids = readCartIds();
    cartListings = phones.filter(phone => ids.includes(String(phone._id)) && phone.status === 'Available');
    renderCart();
  } catch (error) {
    container.innerHTML = `<p class="message">${escapeCart(error.message)}</p>`;
  }
}

document.getElementById('checkoutCart').addEventListener('click', () => {
  if (!cartListings.length) return;
  if (!cartUser) sessionStorage.setItem('phoneBandhuReturnTo', 'cart.html');
  sessionStorage.setItem('phoneBandhuCheckoutCart', JSON.stringify(cartListings.map(phone => ({ productId: String(phone._id), model: phone.model, price: Number(phone.price || 0) }))));
  sessionStorage.removeItem('phoneBandhuCheckoutItem');
  location.href = cartUser ? 'buy-now.html' : 'auth.html';
});

loadCart();
