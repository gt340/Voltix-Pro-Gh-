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
let myReferrer = JSON.parse(localStorage.getItem('voltixMyReferrer') || 'null');
let isAdminAuthed = false;

/* ===== CAPTURE REFERRAL CODE FROM URL ===== */
(function captureRefCode(){
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if(ref) localStorage.setItem('voltixPendingRefCode', ref);
})();

function getCommissionForPrice(price){
  if(COMMISSION_TIERS[price] !== undefined) return COMMISSION_TIERS[price];
  const tiers = Object.keys(COMMISSION_TIERS).map(Number).sort((a,b)=>a-b);
  let match = 0;
  for(const t of tiers){ if(price >= t) match = COMMISSION_TIERS[t]; }
  return match;
}

/* ===== FIREBASE INIT ===== */
(async function initFirebase(){
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const {
    getFirestore, collection, doc, setDoc, addDoc, deleteDoc, getDoc, onSnapshot, getDocs, query
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const {
    getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const {
    getStorage, ref, uploadBytes, getDownloadURL, deleteObject
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const storage = getStorage(app);

  VDB = {
    /* ===== products ===== */
    subscribeProducts(cb){
      return onSnapshot(collection(db,"products"), snap => {
        const list = [];
        snap.forEach(d => list.push({ id:d.id, ...d.data() }));
        list.sort((a,b)=>a.name.localeCompare(b.name));
        cb(list);
      });
    },
    async getProductById(id){
      const snap = await getDoc(doc(db,"products",String(id)));
      return snap.exists() ? { id:snap.id, ...snap.data() } : null;
    },
    async saveProduct(data){
      const toSave = {...data};
      if(data.id){ const id=String(data.id); delete toSave.id; await setDoc(doc(db,"products",id),toSave,{merge:true}); return id; }
      delete toSave.id; const ref2 = await addDoc(collection(db,"products"),toSave); return ref2.id;
    },
    async deleteProductById(id){ await deleteDoc(doc(db,"products",String(id))); },
    async seedIfEmpty(defaults){
      const snap = await getDocs(query(collection(db,"products")));
      if(snap.empty){ for(const p of defaults) await setDoc(doc(db,"products",p.id),p); }
    },

    /* ===== product image uploads (multiple) ===== */
    async uploadProductImages(files){
      const urls = [];
      for(const file of files){
        const path = `products/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.name}`;
        const sRef = ref(storage, path);
        await uploadBytes(sRef, file);
        const url = await getDownloadURL(sRef);
        urls.push(url);
      }
      return urls;
    },
    async deleteStorageFileByUrl(url){
      try{ const sRef = ref(storage, url); await deleteObject(sRef); }
      catch(e){ /* not a storage url or already gone — ignore */ }
    },

    /* ===== store music (multiple tracks) ===== */
    async uploadMusicFiles(files){
      const current = await this.getMusicTracks();
      const newTracks = [];
      for(const file of files){
        const path = `music/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.name}`;
        const sRef = ref(storage, path);
        await uploadBytes(sRef, file);
        const url = await getDownloadURL(sRef);
        newTracks.push({ url, name:file.name });
      }
      const merged = [...current, ...newTracks];
      await setDoc(doc(db,"settings","store"),{ musicTracks: merged },{ merge:true });
      return merged;
    },
    async getMusicTracks(){
      const snap = await getDoc(doc(db,"settings","store"));
      return snap.exists() && Array.isArray(snap.data().musicTracks) ? snap.data().musicTracks : [];
    },
    async removeMusicTrack(url){
      const current = await this.getMusicTracks();
      const updated = current.filter(t=>t.url!==url);
      await setDoc(doc(db,"settings","store"),{ musicTracks: updated },{ merge:true });
      this.deleteStorageFileByUrl(url);
    },
    subscribeMusic(cb){
      return onSnapshot(doc(db,"settings","store"), s => {
        cb(s.exists() && Array.isArray(s.data().musicTracks) ? s.data().musicTracks : []);
      });
    },

    /* ===== referrals ===== */
    async addReferrer(data){ const ref2 = await addDoc(collection(db,"referrers"),{...data,createdAt:new Date().toISOString()}); return ref2.id; },
    subscribeReferrers(cb){ return onSnapshot(collection(db,"referrers"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async addReferralSale(data){ const ref2 = await addDoc(collection(db,"referralSales"),{...data,status:'pending',createdAt:new Date().toISOString()}); return ref2.id; },
    subscribeReferralSales(cb){ return onSnapshot(collection(db,"referralSales"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async updateReferralSaleStatus(id,status){ await setDoc(doc(db,"referralSales",id),{status},{merge:true}); },

    /* ===== admin auth ===== */
    adminLogin(email,pw){ return signInWithEmailAndPassword(auth,email,pw); },
    adminLogout(){ return signOut(auth); },
    watchAdminAuth(cb){ onAuthStateChanged(auth,u=>cb(u)); },
    adminResetPassword(email){ return sendPasswordResetEmail(auth,email); }
  };

  VDB.watchAdminAuth((user) => { isAdminAuthed = !!user; });

  window.dispatchEvent(new Event('vdb-ready'));
})();

/* ===== CART ===== */
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

/* ===== PRODUCT CARD RENDERER ===== */
function productCardHTML(p){
  const firstImg = (p.images && p.images.length) ? p.images[0] : p.imageUrl;
  const img = firstImg ? `<img src="${firstImg}" alt="${p.name}">` : `<span>${p.emoji||'🎧'}</span>`;
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
      <div style="font-size:.62rem;font-weight:800;color:var(--gold);margin-bottom:.5rem;">💸 Earn Ghc${getCommissionForPrice(p.price)} referring this</div>
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
