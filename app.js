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

function isVideoUrl(url){
  if(!url) return false;
  return /\.(mp4|webm|mov|m4v|ogg|ogv)(\?|#|$)/i.test(url);
}
function mediaTagHTML(url, alt, extraAttrs){
  extraAttrs = extraAttrs || '';
  if(isVideoUrl(url)) return `<video src="${url}" muted loop playsinline autoplay ${extraAttrs}></video>`;
  return `<img src="${url}" alt="${alt||''}" ${extraAttrs}>`;
}

const CLOUDINARY_CLOUD_NAME = 'gi28yswe';
const CLOUDINARY_UPLOAD_PRESET = 'Voltix Pro GH';

async function uploadFileToCloudinary(file, onProgress){
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`;
  if(CLOUDINARY_CLOUD_NAME === 'YOUR_CLOUD_NAME' || CLOUDINARY_UPLOAD_PRESET === 'YOUR_UPLOAD_PRESET'){
    throw new Error('Cloudinary is not configured yet — paste your real Cloud name and unsigned upload preset into CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET near the top of app.js.');
  }
  return new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.timeout = 180000;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    xhr.upload.onprogress = (e)=>{
      if(onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = ()=>{
      if(xhr.status >= 200 && xhr.status < 300){
        try{ resolve(JSON.parse(xhr.responseText).secure_url); }
        catch(e){ reject(new Error('Cloudinary returned an unexpected response.')); }
      } else {
        let msg = `Cloudinary upload failed (HTTP ${xhr.status}).`;
        try{
          const parsed = JSON.parse(xhr.responseText);
          if(parsed?.error?.message) msg = 'Cloudinary: ' + parsed.error.message;
        } catch(e){}
        if(xhr.status === 400 && /preset/i.test(msg)) msg += ' Check that the upload preset name is exact and its Signing Mode is set to "Unsigned".';
        reject(new Error(msg));
      }
    };
    xhr.onerror = ()=> reject(new Error('Network error while uploading to Cloudinary — check your connection and try again.'));
    xhr.ontimeout = ()=> reject(new Error('Upload timed out after 3 minutes — try a smaller MP3 (under ~10MB) or a stronger connection.'));
    xhr.send(formData);
  });
}

let VDB = null;
let allProducts = [];
let cart = JSON.parse(localStorage.getItem('voltixCart') || '[]');
let wishlist = JSON.parse(localStorage.getItem('voltixWishlist') || '[]');
let recentlyViewed = JSON.parse(localStorage.getItem('voltixRecentlyViewed') || '[]');
let currentUser = JSON.parse(localStorage.getItem('voltixUser') || 'null');
let myReferrer = JSON.parse(localStorage.getItem('voltixMyReferrer') || 'null');
let isAdminAuthed = false;

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

function getMyReferrer(){
  return JSON.parse(localStorage.getItem('voltixMyReferrer') || 'null');
}
function shareProductCard(id, e){
  if(e) e.stopPropagation();
  const p = allProducts.find(x=>String(x.id)===String(id));
  if(!p) return;
  const ref = getMyReferrer();
  if(!ref){
    window.location.href = 'product.html?id=' + encodeURIComponent(id);
    return;
  }
  const params = new URLSearchParams();
  params.set('id', p.id);
  params.set('ref', ref.code);
  const url = `${window.location.origin}/product.html?${params.toString()}`;
  const text = `Check out the ${p.name} on Voltix Pro GH — premium earpods, real prices! 🎧⚡`;
  if(navigator.share){
    navigator.share({ title:'Voltix Pro GH', text, url }).catch(()=>{});
  } else {
    window.open(`https://wa.me/?text=${encodeURIComponent(text+' '+url)}`, '_blank');
  }
}

(async function initFirebase(){
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const {
    getFirestore, collection, doc, setDoc, addDoc, deleteDoc, getDoc, onSnapshot, getDocs, query
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const {
    getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const {
    getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");

  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const storage = getStorage(app);

  const STORAGE_UPLOAD_TIMEOUT_MS = 360000;

  function uploadFileToStorage(path, file, onProgress){
    const sRef = ref(storage, path);
    const task = uploadBytesResumable(sRef, file);
    return new Promise((resolve, reject)=>{
      const timer = setTimeout(()=>{
        task.cancel();
        reject(new Error(`timed out after ${Math.round(STORAGE_UPLOAD_TIMEOUT_MS/60000)} minutes`));
      }, STORAGE_UPLOAD_TIMEOUT_MS);
      task.on('state_changed',
        snapshot => { if(onProgress && snapshot.totalBytes) onProgress(Math.round((snapshot.bytesTransferred/snapshot.totalBytes)*100)); },
        err => { clearTimeout(timer); reject(err); },
        async () => {
          clearTimeout(timer);
          try{ resolve(await getDownloadURL(sRef)); }
          catch(err){ reject(err); }
        }
      );
    });
  }
  function storageErrorMessage(file, err){
    const code = err.code ? ` (${err.code})` : '';
    const hint = (err.code==='storage/unauthorized' || /timed out/i.test(err.message))
      ? ' — check Firebase Console → Storage → Rules allows writes, and that you are logged into Admin.'
      : '';
    return `Failed to upload "${file.name}"${code}: ${err.message}${hint}`;
  }

  VDB = {
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

    async uploadProductImages(files, onFileProgress){
      const urls = [];
      for(let i=0;i<files.length;i++){
        const file = files[i];
        const path = `products/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.name}`;
        try{
          const url = await uploadFileToStorage(path, file, pct=>{ if(onFileProgress) onFileProgress(i, pct, file.name); });
          urls.push(url);
        } catch(err){
          throw new Error(storageErrorMessage(file, err));
        }
      }
      return urls;
    },
    async deleteStorageFileByUrl(url){
      try{ const sRef = ref(storage, url); await deleteObject(sRef); }
      catch(e){}
    },

    async uploadHeroMedia(file, onProgress){
      const type = file.type.startsWith('video/') ? 'video' : 'image';
      const path = `hero/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.name}`;
      try{
        const url = await uploadFileToStorage(path, file, onProgress);
        const heroMedia = { url, type };
        await setDoc(doc(db,"settings","store"),{ heroMedia },{ merge:true });
        return heroMedia;
      } catch(err){
        throw new Error(storageErrorMessage(file, err));
      }
    },
    async removeHeroMedia(){
      await setDoc(doc(db,"settings","store"),{ heroMedia: null },{ merge:true });
    },
    subscribeHeroMedia(cb){
      return onSnapshot(doc(db,"settings","store"), s=>{
        cb(s.exists() ? (s.data().heroMedia || null) : null);
      });
    },

    async uploadPromoImage(file, onProgress){
      const path = `promo/${Date.now()}_${Math.random().toString(36).slice(2)}_${file.name}`;
      try{
        return await uploadFileToStorage(path, file, onProgress);
      } catch(err){
        throw new Error(storageErrorMessage(file, err));
      }
    },
    async savePromoBanner(data){
      await setDoc(doc(db,"settings","store"),{ promoBanner: data },{ merge:true });
    },
    subscribePromoBanner(cb){
      return onSnapshot(doc(db,"settings","store"), s=>{
        cb(s.exists() ? (s.data().promoBanner || null) : null);
      });
    },

    async uploadMusicFiles(files, onFileProgress){
      const current = await this.getMusicTracks();
      const results = await Promise.all(files.map((file, idx) =>
        uploadFileToCloudinary(file, pct => { if(onFileProgress) onFileProgress(idx, pct, file.name); })
          .then(url => ({ url, name: file.name }))
          .catch(err => { throw new Error(`Failed to upload "${file.name}": ${err.message}`); })
      ));
      const merged = [...current, ...results];
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
    },
    subscribeMusic(cb){
      return onSnapshot(doc(db,"settings","store"), s => {
        cb(s.exists() && Array.isArray(s.data().musicTracks) ? s.data().musicTracks : []);
      });
    },

    async addReferrer(data){ const ref2 = await addDoc(collection(db,"referrers"),{...data,createdAt:new Date().toISOString()}); return ref2.id; },
    subscribeReferrers(cb){ return onSnapshot(collection(db,"referrers"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async addReferralSale(data){ const ref2 = await addDoc(collection(db,"referralSales"),{...data,status:'pending',createdAt:new Date().toISOString()}); return ref2.id; },
    subscribeReferralSales(cb){ return onSnapshot(collection(db,"referralSales"), snap=>{ const l=[]; snap.forEach(d=>l.push({id:d.id,...d.data()})); l.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); cb(l); }); },
    async updateReferralSaleStatus(id,status){ await setDoc(doc(db,"referralSales",id),{status},{merge:true}); },

    subscribeSpinWinners(cb){
      return onSnapshot(collection(db,"spinWinners"), snap=>{
        const list=[]; snap.forEach(d=>list.push({id:d.id,...d.data()}));
        list.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        cb(list);
      }, err=>{
        console.error('spinWinners subscription failed:', err.message);
        const box = document.getElementById('spinWinnersList');
        if(box) box.innerHTML = `<p style="color:#f87171;text-align:center;padding:2rem 0;">Failed to load: ${err.message}</p>`;
      });
    },
    subscribeSpinReferrals(cb){
      return onSnapshot(collection(db,"spinReferrals"), snap=>{
        const list=[]; snap.forEach(d=>list.push({id:d.id,...d.data()}));
        list.sort((a,b)=>new Date(b.rewardedAt)-new Date(a.rewardedAt));
        cb(list);
      }, err=>{
        console.error('spinReferrals subscription failed:', err.message);
        const box = document.getElementById('spinReferralsList');
        if(box) box.innerHTML = `<p style="color:#f87171;text-align:center;padding:2rem 0;">Failed to load: ${err.message}</p>`;
      });
    },

    /* ===== PHASE 1: ORDERS ===== */
    async saveOrder(data){
      const toSave = { ...data, createdAt: new Date().toISOString() };
      const ref2 = await addDoc(collection(db,"orders"), toSave);
      return ref2.id;
    },
    subscribeOrders(cb){
      return onSnapshot(collection(db,"orders"), snap=>{
        const list=[]; snap.forEach(d=>list.push({id:d.id,...d.data()}));
        list.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        cb(list);
      }, err=>{
        console.error('orders subscription failed:', err.message);
        const box = document.getElementById('adminOrdersList');
        if(box) box.innerHTML = `<p style="color:#f87171;text-align:center;padding:2rem 0;">Failed to load: ${err.message}</p>`;
      });
    },
    async getOrdersByPhone(phone){
      const snap = await getDocs(query(collection(db,"orders")));
      const list = [];
      snap.forEach(d=>{ const data=d.data(); if(data.customer?.phone===phone) list.push({id:d.id,...data}); });
      list.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
      return list;
    },
    async updateOrderStatus(id, status){
      await setDoc(doc(db,"orders",id), { status }, { merge:true });
    },

    adminLogin(email,pw){ return signInWithEmailAndPassword(auth,email,pw); },
    adminLogout(){ return signOut(auth); },
    watchAdminAuth(cb){ onAuthStateChanged(auth,u=>cb(u)); },
    adminResetPassword(email){ return sendPasswordResetEmail(auth,email); }
  };

  VDB.watchAdminAuth((user) => { isAdminAuthed = !!user; });

  window.dispatchEvent(new Event('vdb-ready'));
})();

function cartCount(){ return cart.reduce((s,i)=>s+i.qty,0); }
function cartTotal(){ return cart.reduce((s,i)=>s+(i.price*i.qty),0); }
function addToCart(id, qty=1, variant=null){
  const p = allProducts.find(x=>String(x.id)===String(id));
  if(!p) return;
  const lineId = variant ? `${id}::${variant.id}` : String(id);
  const existing = cart.find(i=>(i.lineId||i.id)===lineId);
  if(existing){
    existing.qty += qty;
  } else {
    const img = variant
      ? (variant.images && variant.images[0])
      : ((p.images && p.images[0]) || p.imageUrl);
    cart.push({
      id: String(id),
      lineId,
      variantId: variant ? variant.id : null,
      variantName: variant ? variant.name : null,
      sku: variant ? (variant.sku||null) : (p.sku||null),
      name: variant ? `${p.name} — ${variant.name}` : p.name,
      price: variant ? variant.price : p.price,
      image: img || null,
      qty
    });
  }
  saveCart();
  showToast(`Added ${variant ? variant.name+' ' : ''}${p.name} to cart`);
  updateNavBadges();
}
function updateCartQty(lineId, qty){
  const item = cart.find(i=>(i.lineId||i.id)===lineId);
  if(!item) return;
  if(qty<=0){ cart = cart.filter(i=>(i.lineId||i.id)!==lineId); } else { item.qty = qty; }
  saveCart(); updateNavBadges();
  if(typeof renderCartPage==='function') renderCartPage();
}
function removeFromCart(lineId){ updateCartQty(lineId,0); }
function saveCart(){ localStorage.setItem('voltixCart', JSON.stringify(cart)); }

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

function trackRecentlyViewed(id){
  recentlyViewed = recentlyViewed.filter(r=>String(r)!==String(id));
  recentlyViewed.unshift(id);
  recentlyViewed = recentlyViewed.slice(0,10);
  localStorage.setItem('voltixRecentlyViewed', JSON.stringify(recentlyViewed));
}

function updateNavBadges(){
  const cartBadge = document.getElementById('navCartCount');
  if(cartBadge){ const c=cartCount(); cartBadge.textContent=c; cartBadge.style.display = c>0?'flex':'none'; }
  const wishBadge = document.getElementById('navWishCount');
  if(wishBadge){ const c=wishlist.length; wishBadge.textContent=c; wishBadge.style.display = c>0?'flex':'none'; }
}

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

function productCardHTML(p){
  const firstImg = (p.images && p.images.length) ? p.images[0] : p.imageUrl;
  const img = firstImg ? mediaTagHTML(firstImg, p.name) : `<span>${p.emoji||'🎧'}</span>`;
  const wishActive = isWishlisted(p.id) ? 'active' : '';
  const heart = isWishlisted(p.id) ? '♥' : '♡';
  const hasVariants = p.variants && p.variants.length > 1;
  const addBtnHTML = hasVariants
    ? `<button class="pcard-addbtn ripple" onclick="event.stopPropagation(); goToProduct('${p.id}');">🎨 Choose Colour</button>`
    : `<button class="pcard-addbtn ripple" onclick="event.stopPropagation(); addToCart('${p.id}'); rippleFx(event);">Add to Cart</button>`;
  return `
    <div class="glass-card pcard" onclick="goToProduct('${p.id}')">
      <div class="pcard-img">
        ${p.badge ? `<span class="pcard-badge ${p.badgeClass||''}">${p.badge}</span>` : ''}
        <button class="wish-toggle ${wishActive}" data-id="${p.id}" onclick="event.stopPropagation(); toggleWishlist('${p.id}')">${heart}</button>
        ${img}
      </div>
      <div class="pcard-name">${p.name}</div>
      ${hasVariants ? `<div style="font-size:.6rem;font-weight:800;color:var(--blue-electric);margin-bottom:.2rem;">🎨 ${p.variants.length} colours</div>` : ''}
      <div class="pcard-rating">★★★★★ <span class="count">(${(p.reviewCount||Math.floor(Math.random()*80)+20)})</span></div>
      <div class="pcard-price-row">
        <span class="pcard-price">Ghc${p.price}</span>
        ${p.oldPrice ? `<span class="pcard-oldprice">Ghc${p.oldPrice}</span>` : ''}
      </div>
      <div style="font-size:.62rem;font-weight:800;color:var(--gold);margin-bottom:.5rem;">💸 Earn Ghc${getCommissionForPrice(p.price)} referring this</div>
      <div style="display:flex;gap:.4rem;align-items:center;">
        ${addBtnHTML}
        <button class="wish-toggle" style="position:static;width:2.1rem;height:2.1rem;flex-shrink:0;" aria-label="Share this product" onclick="shareProductCard('${p.id}', event)">🔗</button>
      </div>
    </div>`;
}
function goToProduct(id){
  trackRecentlyViewed(id);
  window.location.href = 'product.html?id=' + encodeURIComponent(id);
}

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

function setActiveNav(page){
  document.querySelectorAll('.nav-item').forEach(el=>{
    el.classList.toggle('active', el.dataset.page===page);
  });
}

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

let storeTracks = [];
let storeTrackIndex = 0;
let musicPlaying = false;
const MUSIC_STATE_KEY = 'voltixMusicState';

function saveMusicState(){
  const audio = document.getElementById('storeAudio');
  if(!audio) return;
  localStorage.setItem(MUSIC_STATE_KEY, JSON.stringify({
    trackIndex: storeTrackIndex,
    currentTime: audio.currentTime || 0,
    isPlaying: musicPlaying,
    savedAt: Date.now()
  }));
}
function loadMusicState(){
  try{ return JSON.parse(localStorage.getItem(MUSIC_STATE_KEY) || 'null'); } catch(e){ return null; }
}
function updateMusicBtnUI(){
  const btn = document.getElementById('musicToggleBtn');
  if(btn) btn.textContent = musicPlaying ? '⏸' : '🎵';
  document.querySelectorAll('.playlist-track-row').forEach(row=>{
    const isCurrent = parseInt(row.dataset.index,10) === storeTrackIndex;
    row.classList.toggle('playing', isCurrent && musicPlaying);
    const icon = row.querySelector('.playlist-track-icon');
    if(icon) icon.textContent = (isCurrent && musicPlaying) ? '⏸' : '▶';
  });
}
function renderMusicPlaylist(){
  const list = document.getElementById('musicPlaylistList');
  if(!list) return;
  if(!storeTracks.length){
    list.innerHTML = '<p style="padding:1rem;color:var(--text-muted);font-size:.8rem;text-align:center;">No tracks uploaded yet.</p>';
    return;
  }
  list.innerHTML = storeTracks.map((t,i)=>`
    <button type="button" class="playlist-track-row ${i===storeTrackIndex && musicPlaying?'playing':''}" data-index="${i}" onclick="playTrackAtIndex(${i})">
      <span class="playlist-track-icon">${i===storeTrackIndex && musicPlaying ? '⏸' : '▶'}</span>
      <span class="playlist-track-name">${t.name}</span>
    </button>`).join('');
}
function toggleMusicPlaylist(){
  const panel = document.getElementById('musicPlaylistPanel');
  if(panel) panel.classList.toggle('active');
}
function playTrackAtIndex(i){
  const audio = document.getElementById('storeAudio');
  if(!audio || !storeTracks[i]) return;
  if(i === storeTrackIndex && musicPlaying){
    audio.pause();
    musicPlaying = false;
  } else {
    storeTrackIndex = i;
    audio.src = storeTracks[i].url;
    audio.currentTime = 0;
    audio.play().then(()=>{ musicPlaying = true; updateMusicBtnUI(); saveMusicState(); }).catch(()=>{});
    musicPlaying = true;
  }
  updateMusicBtnUI();
  saveMusicState();
}
function toggleStoreMusic(){
  const audio = document.getElementById('storeAudio');
  if(!audio) return;
  if(!storeTracks.length){ showToast('No store music uploaded yet'); return; }
  if(musicPlaying){
    audio.pause();
    musicPlaying = false;
  } else {
    if(!audio.src) audio.src = storeTracks[storeTrackIndex].url;
    audio.play().catch(()=>{});
    musicPlaying = true;
  }
  updateMusicBtnUI();
  saveMusicState();
}
function initStoreMusic(){
  const audio = document.getElementById('storeAudio');
  if(!audio) return;
  function apply(){
    VDB.getMusicTracks().then(tracks=>{
      storeTracks = tracks || [];
      renderMusicPlaylist();
      const state = loadMusicState();
      if(state && storeTracks[state.trackIndex]){
        storeTrackIndex = state.trackIndex;
        audio.src = storeTracks[storeTrackIndex].url;
        if(state.isPlaying){
          audio.addEventListener('loadedmetadata', function seekOnce(){
            audio.currentTime = state.currentTime || 0;
            audio.removeEventListener('loadedmetadata', seekOnce);
            audio.play().then(()=>{ musicPlaying = true; updateMusicBtnUI(); })
                        .catch(()=>{ musicPlaying = false; updateMusicBtnUI(); });
          });
        }
      }
      updateMusicBtnUI();
    });
  }
  if(typeof VDB !== 'undefined' && VDB) apply(); else window.addEventListener('vdb-ready', apply);

  audio.addEventListener('timeupdate', ()=>{
    if(Math.floor(audio.currentTime) % 3 === 0) saveMusicState();
  });
  audio.addEventListener('ended', ()=>{
    if(!storeTracks.length) return;
    storeTrackIndex = (storeTrackIndex + 1) % storeTracks.length;
    audio.src = storeTracks[storeTrackIndex].url;
    audio.play().catch(()=>{});
    updateMusicBtnUI();
    saveMusicState();
  });
  window.addEventListener('pagehide', saveMusicState);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) saveMusicState(); });
}
