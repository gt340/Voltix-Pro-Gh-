/* ========== VOLTIX PRO GH — CORE APP LOGIC ========== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAponv8T3TBWaGRNW0Sa9DEmRFAmOY8DFc",
  authDomain: "voltix-pro-dc363.firebaseapp.com",
  projectId: "voltix-pro-dc363",
  storageBucket: "voltix-pro-dc363.firebasestorage.app",
  messagingSenderId: "778425016855",
  appId: "1:778425016855:web:6bbe58c7e8b7ffa9ccf252"
};

const COMMISSION_TIERS = { 40:5, 120:7, 130:7, 220:10 };

let VDB = null;
let allProducts = [];
let cart = JSON.parse(localStorage.getItem('voltixCart') || '[]');
let wishlist = JSON.parse(localStorage.getItem('voltixWishlist') || '[]');
let recentlyViewed = JSON.parse(localStorage.getItem('voltixRecentlyViewed') || '[]');
let currentUser = JSON.parse(localStorage.getItem('voltixUser') || 'null');

/* ===== FIREBASE INIT (dynamic import, works in classic script) ===== */
(async function initFirebase(){
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const {
    getFirestore, collection, doc, setDoc, addDoc, deleteDoc, onSnapshot, getDocs, query
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const {
    getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const auth = getAuth(app);

  VDB = {
    subscribeProducts(cb){
      return onSnapshot(collection(db,"products"), snap => {
        const list = [];
        snap.forEach(d => list.push({ id:d.id, ...d.data() }));
        list.sort((a,b)=>a.name.localeCompare(b.name));
        cb(list);
      });
    },
    async saveProduct(data){
      const toSave = {...data};
      if(data.id){ const id=String(data.id); delete toSave.id; await setDoc(doc(db,"products",id),toSave,{merge:true}); return id; }
      delete toSave.id; const ref = await addDoc(collection(db,"products"),toSave); return ref.id;
    },
    async deleteProductById(id){ await deleteDoc(doc(db,"products",String(id))); },
    async saveMusicUrl(url,name){ await setDoc(doc(db,"settings","store"),{musicUrl:url,musicName:name},{merge:true}); },
    async removeMusicUrl(){ await setDoc(doc(db,"settings","store"),{musicUrl:null,musicName:null},{merge:true}); },
    subscribeMusic(cb){ return onSnapshot(doc(db,"settings","store"), s => cb(s.exists()?s.data():{musicUrl:null,musicName:null})); },
    async addReferrer(data){ const ref = await addDoc(collection(db,"referrers"),{...data,createdAt:new Date().toISOString()}); return ref.id; },
    subscribeReferrers(cb){ return onSnapshot(collection(db,"referrers"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async addReferralSale(data){ const ref = await addDoc(collection(db,"referralSales"),{...data,status:'pending',createdAt:new Date().toISOString()}); return ref.id; },
    subscribeReferralSales(cb){ return onSnapshot(collection(db,"referralSales"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async updateReferralSaleStatus(id,status){ await setDoc(doc(db,"referralSales",id),{status},{merge:true}); },
    adminLogin(email,pw){ return signInWithEmailAndPassword(auth,email,pw); },
    adminLogout(){ return signOut(auth); },
    watchAdminAuth(cb){ onAuthStateChanged(auth,u=>cb(u)); },
    adminResetPassword(email){ return sendPasswordResetEmail(auth,email); },
    async seedIfEmpty(defaults){
      const snap = await getDocs(query(collection(db,"products")));
      if(snap.empty){ for(const p of defaults) await setDoc(doc(db,"products",p.id),p); }
    }
  };

  window.dispatchEvent(new Event('vdb-ready'));
})();

/* ===== CART ===== */
function getCommissionForPrice(price){
  if(COMMISSION_TIERS[price]!==undefined) return COMMISSION_TIERS[price];
  const tiers = Object.keys(COMMISSION_TIERS).map(Number).sort((a,b)=>a-b);
  let m=0; for(const t of tiers){ if(price>=t) m=COMMISSION_TIERS[t]; } return m;
}
function cartCount(){ return cart.reduce((s,i)=>s+i.qty,0); }
function cartTotal(){ return cart.reduce((s,i)=>s+(i.price*i.qty),0); }
function addToCart(id, qty=1){
  const p = allProducts.find(x=>String(x.id)===String(id));
  if(!p) return;
  const existing = cart.find(i=>String(i.id)===String(id));
  if(existing) existing.qty += qty; else cart.push({...p, qty});
  saveCart();
  showToast(`Added ${p.name} to cart`);
  updateNavBadges();
}
function updateCartQty(id, qty){
  const item = cart.find(i=>String(i.id)===String(id));
  if(!item) return;
  if(qty<=0){ cart = cart.filter(i=>String(i.id)!==String(id)); } else { item.qty = qty; }
  saveCart(); updateNavBadges();
  if(typeof renderCartPage==='function') renderCartPage();
}
function removeFromCart(id){ updateCartQty(id,0); }
function saveCart(){ localStorage.setItem('voltixCart', JSON.stringify(cart)); }

/* ===== WISHLIST ===== */
function isWishlisted(id){ return wishlist.some(w=>String(w)===String(id)); }
function toggleWishlist(id){
  if(isWishlisted(id)) wishlist = wishlist.filter(w=>String(w)!==String(id));
  else wishlist.push(id);
  localStorage.setItem('voltixWishlist', JSON.stringify(wishlist));
  updateNavBadges();
  document.querySelectorAll(`.wish-toggle[data-id="${id}"]`).forEach(btn=>{
    btn.classList.toggle('active', isWishlisted(id));
    btn.textContent = isWishlisted(id) ? '♥' : '♡';
  });
}

/* ===== RECENTLY VIEWED ===== */
function trackRecentlyViewed(id){
  recentlyViewed = recentlyViewed.filter(r=>String(r)!==String(id));
  recentlyViewed.unshift(id);
  recentlyViewed = recentlyViewed.slice(0,10);
  localStorage.setItem('voltixRecentlyViewed', JSON.stringify(recentlyViewed));
}

/* ===== NAV BADGES ===== */
function updateNavBadges(){
  const cartBadge = document.getElementById('navCartCount');
  if(cartBadge){ const c=cartCount(); cartBadge.textContent=c; cartBadge.style.display = c>0?'flex':'none'; }
  const wishBadge = document.getElementById('navWishCount');
  if(wishBadge){ const c=wishlist.length; wishBadge.textContent=c; wishBadge.style.display = c>0?'flex':'none'; }
}

/* ===== TOAST ===== */
function showToast(msg){
  let t = document.getElementById('voltixToast');
  if(!t){
    t = document.createElement('div');
    t.id='voltixToast';
    t.style.cssText='position:fixed;bottom:5.5rem;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(10,17,40,.95);border:1px solid rgba(14,165,233,.4);color:#fff;padding:.75rem 1.4rem;border-radius:999px;font-size:.8rem;font-weight:700;z-index:200;opacity:0;transition:all .3s;backdrop-filter:blur(10px);box-shadow:0 8px 24px rgba(0,0,0,.4);';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateX(-50%) translateY(0)'; });
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(()=>{ t.style.opacity='0'; t.style.transform='translateX(-50%) translateY(20px)'; }, 2200);
}

/* ===== PRODUCT CARD RENDERER (reused across pages) ===== */
function productCardHTML(p){
  const img = p.imageUrl ? `<img src="${p.imageUrl}" alt="${p.name}">` : `<span>${p.emoji||'🎧'}</span>`;
  const wishActive = isWishlisted(p.id) ? 'active' : '';
  const heart = isWishlisted(p.id) ? '♥' : '♡';
  return `
    <div class="glass-card pcard" onclick="goToProduct('${p.id}')">
      <div class="pcard-img">
        ${p.badge ? `<span class="pcard-badge ${p.badgeClass||''}">${p.badge}</span>` : ''}
        <button class="wish-toggle ${wishActive}" data-id="${p.id}" onclick="event.stopPropagation(); toggleWishlist('${p.id}')">${heart}</button>
        ${img}
      </div>
      <div class="pcard-name">${p.name}</div>
      <div class="pcard-rating">★★★★★ <span class="count">(${(p.reviewCount||Math.floor(Math.random()*80)+20)})</span></div>
      <div class="pcard-price-row">
        <span class="pcard-price">Ghc${p.price}</span>
        ${p.oldPrice ? `<span class="pcard-oldprice">Ghc${p.oldPrice}</span>` : ''}
      </div>
      <button class="pcard-addbtn ripple" onclick="event.stopPropagation(); addToCart('${p.id}'); rippleFx(event);">Add to Cart</button>
    </div>`;
}
function goToProduct(id){
  trackRecentlyViewed(id);
  window.location.href = 'product.html?id=' + encodeURIComponent(id);
}

/* ===== RIPPLE EFFECT ===== */
function rippleFx(e){
  const btn = e.currentTarget;
  const circle = document.createElement('span');
  const d = Math.max(btn.clientWidth, btn.clientHeight);
  circle.style.width = circle.style.height = d+'px';
  const rect = btn.getBoundingClientRect();
  circle.style.left = (e.clientX - rect.left - d/2)+'px';
  circle.style.top = (e.clientY - rect.top - d/2)+'px';
  circle.className='ripple-circle';
  btn.appendChild(circle);
  setTimeout(()=>circle.remove(),600);
}
document.addEventListener('click', e=>{
  const el = e.target.closest('.ripple');
  if(el) rippleFx({currentTarget:el, clientX:e.clientX, clientY:e.clientY});
});

/* ===== BOTTOM NAV ACTIVE STATE ===== */
function setActiveNav(page){
  document.querySelectorAll('.nav-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.page===page);
  });
}

/* ===== INIT ON EVERY PAGE ===== */
function initVoltixApp(pageName, onProductsReady){
  setActiveNav(pageName);
  updateNavBadges();
  function loadProducts(){
    VDB.subscribeProducts(list=>{
      allProducts = list;
      if(onProductsReady) onProductsReady(list);
    });
  }
  if(VDB) loadProducts(); else window.addEventListener('vdb-ready', loadProducts);
}
