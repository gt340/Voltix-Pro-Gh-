const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const payments = require('./payments');
const { createArkeselOtpClient } = require('./arkesel-otp');
const { createOtpAuthService } = require('./otp-auth');

const IS_VERCEL_PREVIEW = process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'preview';
const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!firebaseServiceAccount || typeof firebaseServiceAccount.project_id !== 'string') {
  throw new Error('FIREBASE_SERVICE_ACCOUNT must contain a valid project_id');
}
if (IS_VERCEL_PREVIEW) {
  const expectedPreviewProject = process.env.PREVIEW_FIREBASE_PROJECT_ID;
  if (!expectedPreviewProject || firebaseServiceAccount.project_id !== expectedPreviewProject) {
    throw new Error('Preview backend requires a dedicated Firebase project; refusing to start');
  }
  if (process.env.PAYSTACK_SECRET_KEY || process.env.RELOADLY_CLIENT_ID ||
      process.env.RELOADLY_CLIENT_SECRET || process.env.OTP_AUTH_ENABLED === 'true') {
    throw new Error('Preview backend must not have live payment, top-up, or SMS credentials enabled');
  }
}
admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount)
});
const db = admin.firestore();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use('/api/paystack-webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

// Preview deployments are read-only at the API boundary. This blocks direct
// requests as well as UI-triggered writes, including Paystack, spins, and OTP.
app.use((req, res, next) => {
  if (IS_VERCEL_PREVIEW && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(503).json({ error: 'Preview backend is read-only' });
  }
  next();
});

const otpAuthEnabled = process.env.OTP_AUTH_ENABLED === 'true';
let otpAuthService = null;
if (otpAuthEnabled) {
  try {
    const otpClient = createArkeselOtpClient({
      http: axios,
      apiKey: process.env.ARKESEL_API_KEY,
      senderId: process.env.ARKESEL_SENDER_ID,
      expiryMinutes: 5
    });
    otpAuthService = createOtpAuthService({
      db,
      auth: admin.auth(),
      otpClient,
      hashSecret: process.env.OTP_RATE_LIMIT_SECRET,
      dailyLimit: Number(process.env.OTP_DAILY_GLOBAL_LIMIT) || 250
    });
  } catch (error) {
    // Do not take down wallet, game or Paystack routes if OTP config is absent.
    // OTP endpoints remain unavailable until every required secret is present.
    console.error('OTP auth is disabled because server configuration is incomplete:', error.name);
  }
}

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

const SPIN_COST = 20;
const DAILY_SPIN_CAP = 10;

// ---------- PAYSTACK (server-side verification, shared by verify + webhook) ----------
async function paystackVerify(reference){
  const resp = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    timeout: 15000,
    validateStatus: s => s < 500
  });
  if(resp.status === 401) throw new Error('payment provider rejected credentials');
  if(!resp.data || resp.data.status !== true || !resp.data.data) return { found:false };
  return { found:true, data: resp.data.data };
}
const payDeps = {
  db,
  FieldValue: admin.firestore.FieldValue,
  paystackVerify,
  paystackSecret: PAYSTACK_SECRET_KEY,
  now: () => Date.now()
};

// ---------- EARPOD SPEND TIERS ----------
const EARPOD_TIERS = [
  { id:'earpod_single',    name:'Single Earpod',    value:40,  unlockSpend:80,  freeShipSpend:120 },
  { id:'earpod_ultrapods', name:'Ultrapods',        value:120, unlockSpend:150, freeShipSpend:180 },
  { id:'earpod_openear',   name:'Berlin Open-Ear',  value:130, unlockSpend:170, freeShipSpend:200 },
  { id:'earpod_sporthook', name:'Sport Hook',       value:220, unlockSpend:260, freeShipSpend:270 },
];
function getEligibleEarpodTier(totalSpend){
  let eligible = null;
  for(const tier of EARPOD_TIERS){
    if(totalSpend >= tier.unlockSpend) eligible = tier;
  }
  return eligible;
}

// ---------- PRIZE TABLE ----------
const PRIZES = [
  // Weights total 100. Non-reward outcomes intentionally account for 58%.
  { id:'tryAgain',    weight:38,  type:'none' },
  { id:'zeroCoin',    weight:20,  type:'none' },
  { id:'coins5',      weight:15,  type:'coins',   value:5 },
  { id:'coins10',     weight:10,  type:'coins',   value:10 },
  { id:'airtime1',    weight:7,   type:'airtime', value:1 },
  { id:'airtime2',    weight:4,   type:'airtime', value:2 },
  { id:'data500mb',   weight:2,   type:'data',    value:500 },
  { id:'airtime5',    weight:1,   type:'airtime', value:5 },
  { id:'data1gb',     weight:0.5, type:'data',    value:1000 },
  { id:'coupon10',    weight:0.3, type:'coupon',  value:10 },
  { id:'freeshipping',weight:1.2, type:'freeship' },
  { id:'earpods',     weight:1,   type:'earpods' },
];
function pickPrize(randomInt = crypto.randomInt){
  // Scale weights to integer tenths so crypto.randomInt can preserve 0.1% odds.
  const scale = 10;
  const total = PRIZES.reduce((sum, prize) => sum + Math.round(prize.weight * scale), 0);
  let r = randomInt(total);
  for(const prize of PRIZES){
    const weightUnits = Math.round(prize.weight * scale);
    if(r < weightUnits) return prize;
    r -= weightUnits;
  }
  return PRIZES[0];
}

const prizeLabelMap = {
  coins5:'5 Coins', coins10:'10 Coins', airtime1:'Ghc1 Airtime', airtime2:'Ghc2 Airtime',
  airtime5:'Ghc5 Airtime', data500mb:'500MB Data', data1gb:'1GB Data', coupon10:'10% Off Coupon',
  freeshipping:'Free Shipping Voucher'
};

// ---------- ARKESEL SHOPPER OTP AUTH ----------
// Disabled by default. Enabling this flag can send billable SMS messages.
app.post('/api/auth/otp/request', async (req, res) => {
  if (!otpAuthEnabled || !otpAuthService) {
    return res.status(503).json({ error: 'Phone verification is temporarily unavailable' });
  }
  const phone = req.body && req.body.phone;
  if (typeof phone !== 'string' || phone.length > 32) {
    return res.status(400).json({ error: 'Enter a valid Ghana phone number' });
  }
  try {
    const result = await otpAuthService.requestOtp(phone, req.ip || '');
    return res.status(202).json({ ok: true, ...result });
  } catch (error) {
    if (error.code === 'OTP_RESEND_COOLDOWN' || error.code === 'OTP_RATE_LIMITED') {
      return res.status(429).json({ error: error.message, code: error.code });
    }
    if (error instanceof TypeError) {
      return res.status(400).json({ error: 'Enter a valid Ghana phone number' });
    }
    console.error('OTP request failed:', error && error.name);
    return res.status(502).json({ error: 'Could not send a verification code. Try again later.' });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  if (!otpAuthEnabled || !otpAuthService) {
    return res.status(503).json({ error: 'Phone verification is temporarily unavailable' });
  }
  const body = req.body || {};
  try {
    const result = await otpAuthService.verifyOtp(body.challengeId, body.code);
    return res.json({ customToken: result.customToken });
  } catch (error) {
    const status = error.code === 'OTP_RATE_LIMITED' || error.code === 'OTP_ATTEMPTS_EXCEEDED' ? 429 :
      (error.code === 'OTP_CHALLENGE_INVALID' || error.code === 'OTP_EXPIRED' ? 410 :
        (error.code === 'OTP_CODE_INVALID' || error.code === 'OTP_CODE_INCORRECT' ? 400 :
          (error.code === 'OTP_VERIFY_IN_PROGRESS' ? 409 : 502)));
    if (status === 502) console.error('OTP verification failed:', error && error.name);
    return res.status(status).json({
      error: status === 502 ? 'Could not verify the code. Try again later.' : error.message,
      code: error.code || 'OTP_VERIFICATION_FAILED'
    });
  }
});

// ---------- SHOPPER IDENTITY ----------
// Arkesel OTP verification is exchanged for a Firebase custom token. The
// resulting Firebase ID token must carry the verified phone_number claim;
// wallet access additionally requires an exact ownerUid match.
function normalizePhone(value){
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith('233') && digits.length === 12 ? '0' + digits.slice(3) : digits;
}
async function requireVerifiedShopper(req, res, requestedPhone){
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if(!match){ res.status(401).json({ error:'Shopper authentication required' }); return null; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(match[1]); }
  catch (_) { res.status(401).json({ error:'Invalid or expired shopper token' }); return null; }
  if(typeof decoded.phone_number !== 'string' || !decoded.phone_number){
    res.status(403).json({ error:'Verified phone ownership required for this wallet operation' });
    return null;
  }
  const canonicalPhone = normalizePhone(decoded.phone_number);
  if(!/^0\d{9}$/.test(canonicalPhone)){
    res.status(403).json({ error:'A verified Ghana phone number is required' });
    return null;
  }
  if(requestedPhone && canonicalPhone !== normalizePhone(requestedPhone)){
    res.status(403).json({ error:'Authenticated phone does not own this wallet' });
    return null;
  }
  decoded.walletPhone = canonicalPhone;
  return decoded;
}

// ---------- WALLET LOOKUP ----------
app.get('/api/wallet', async (req,res)=>{
  const shopper = await requireVerifiedShopper(req,res,req.query.phone);
  if(!shopper) return;
  const phone = shopper.walletPhone;
  if(!phone) return res.status(400).json({ error:'phone required' });
  const snap = await db.collection('wallets').doc(phone).get();
  if(!snap.exists) return res.json({ coins: 0, network: null, totalSpend: 0 });
  const data = snap.data() || {};
  if (data.ownerUid !== shopper.uid) {
    return res.status(409).json({ error:'Wallet ownership recovery required', code:'WALLET_OWNER_RECOVERY_REQUIRED' });
  }
  res.json({ coins: data.coins || 0, network: data.network || null, totalSpend: data.totalSpend || 0 });
});

// ---------- FREE STARTER SPIN ----------
app.post('/api/claim-free-spin', async (req,res)=>{
  const { phone: requestedPhone, name } = req.body || {};
  const shopper = await requireVerifiedShopper(req,res,requestedPhone);
  if(!shopper) return;
  const phone = shopper.walletPhone;
  if(!phone || typeof phone !== 'string' || phone.length > 24 || /[\\/]/.test(phone)) return res.status(400).json({ error:'Valid phone required' });
  const walletRef = db.collection('wallets').doc(phone);
  try {
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(walletRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      if(snap.exists && data.ownerUid !== shopper.uid) {
        return { error:'Wallet ownership recovery required', code:'WALLET_OWNER_RECOVERY_REQUIRED' };
      }
      if(data.claimedFreeSpin) return { claimed:false, coins:Number(data.coins)||0 };
      const coins = (Number(data.coins)||0) + 20;
      const updateData = { ownerUid:shopper.uid, coins, claimedFreeSpin:true };
      if(typeof name === 'string') updateData.name = name.slice(0,80);
      tx.set(walletRef, updateData, { merge:true });
      return { claimed:true, coins };
    });
    if(result.error) return res.status(409).json({ error:result.error, code:result.code });
    res.json(result);
  } catch(err) {
    console.error('claim-free-spin failed:', err.message);
    res.status(500).json({ error:'Could not claim starter coins' });
  }
});

// ---------- SPIN REFERRAL CODES ----------
function generateReferralCode(phone){
  return 'VLX' + phone.replace(/\D/g,'').slice(-4) + Math.random().toString(36).slice(2,5).toUpperCase();
}
app.get('/api/spin-referral-code', async (req,res)=>{
  const shopper = await requireVerifiedShopper(req,res,req.query.phone);
  if(!shopper) return;
  const phone = shopper.walletPhone;
  if(!phone) return res.status(400).json({ error:'phone required' });
  const walletRef = db.collection('wallets').doc(phone);
  const snap = await walletRef.get();
  const wallet = snap.exists ? (snap.data() || {}) : null;
  if(wallet && wallet.ownerUid !== shopper.uid) {
    return res.status(409).json({ error:'Wallet ownership recovery required', code:'WALLET_OWNER_RECOVERY_REQUIRED' });
  }
  const existing = wallet ? wallet.spinReferralCode : null;
  if(existing) return res.json({ code: existing });

  const code = generateReferralCode(phone);
  await walletRef.set({ ownerUid:shopper.uid, spinReferralCode: code }, { merge:true });
  await db.collection('spinReferralCodes').doc(code).set({ phone, ownerUid:shopper.uid });
  res.json({ code });
});

// ---------- SPIN WINNERS LOG ----------
async function logSpinWinner(phone, name, prizeLabel, prizeId, shopperUid){
  await db.collection('spinWinners').add({
    phone, shopperUid, name: name || 'Unknown', prizeLabel, prizeId,
    status: 'pending', createdAt: new Date().toISOString()
  });
}
async function isAdminRequest(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if(!match) return false;
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    return adminDoc.exists;
  } catch (_) {
    return false;
  }
}
app.post('/api/mark-winner-fulfilled', async (req,res)=>{
  if(!(await isAdminRequest(req))) return res.status(403).json({ error:'Admin authorization required' });
  const { winnerId } = req.body || {};
  if(typeof winnerId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(winnerId)) return res.status(400).json({ error:'Valid winner ID required' });
  try {
    await db.collection('spinWinners').doc(winnerId).update({ status:'fulfilled', fulfilledAt:new Date().toISOString() });
    res.json({ status:'ok' });
  } catch(err) {
    if(err.code === 5) return res.status(404).json({ error:'Winner record not found' });
    console.error('mark-winner-fulfilled failed:', err.message);
    res.status(500).json({ error:'Could not update winner status' });
  }
});

// ---------- SPIN ----------
app.post('/api/spin', async (req,res)=>{
  const { phone: requestedPhone, network, name } = req.body || {};
  const shopper = await requireVerifiedShopper(req,res,requestedPhone);
  if(!shopper) return;
  const phone = shopper.walletPhone;
  if(!phone) return res.status(400).json({ error:'phone required' });

  if(typeof phone !== 'string' || phone.length > 24 || /[\\/]/.test(phone)) return res.status(400).json({ error:'Valid phone required' });
  const walletRef = db.collection('wallets').doc(phone);
  const spinRef = db.collection('spins').doc();
  const nowDate = new Date();
  const dayKey = nowDate.toISOString().slice(0,10);
  const finalNetworkCandidate = ['MTN','TELECEL','AT'].includes(network) ? network : null;
  let wallet = { coins:0, totalSpend:0, network:null };
  let finalNetwork = 'MTN';
  let prize = pickPrize();
  let earpodTier = null;
  let freeShipping = false;
  try {
    const result = await db.runTransaction(async tx => {
      const walletSnap = await tx.get(walletRef);
      const current = walletSnap.exists ? (walletSnap.data() || {}) : { coins:0, totalSpend:0 };
      if(walletSnap.exists && current.ownerUid !== shopper.uid) {
        return { error:'Wallet ownership recovery required', code:'WALLET_OWNER_RECOVERY_REQUIRED', status:409 };
      }
      const currentCount = current.dailySpinDate === dayKey ? (Number(current.dailySpinCount)||0) : 0;
      const balance = Number(current.coins)||0;
      if(currentCount >= DAILY_SPIN_CAP) return { error:'Daily spin limit reached', status:429 };
      if(balance < SPIN_COST) return { error:'Not enough coins', status:400 };
      wallet = current;
      finalNetwork = finalNetworkCandidate || current.network || 'MTN';
      if(prize.type === 'earpods'){
        earpodTier = getEligibleEarpodTier(Number(current.totalSpend)||0);
        if(!earpodTier) prize = { id:'tryAgain', type:'none' };
        else freeShipping = (Number(current.totalSpend)||0) >= earpodTier.freeShipSpend;
      }
      const updateData = {
        ownerUid: shopper.uid,
        coins: balance - SPIN_COST,
        network: finalNetwork,
        dailySpinDate: dayKey,
        dailySpinCount: currentCount + 1
      };
      if(typeof name === 'string') updateData.name = name.slice(0,80);
      tx.set(walletRef, updateData, { merge:true });
      tx.set(spinRef, { phone, shopperUid:shopper.uid, prizeId:prize.id, network:finalNetwork, createdAt:nowDate.toISOString(), dayKey }, { merge:false });
      return { ok:true };
    });
    if(result.error) return res.status(result.status).json({ error:result.error, code:result.code || 'SPIN_REJECTED' });
  } catch(err) {
    console.error('spin transaction failed:', err.message);
    return res.status(500).json({ error:'Could not process spin' });
  }
  try{
    if(prize.type === 'coins'){
      await walletRef.update({ coins: admin.firestore.FieldValue.increment(prize.value) });
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id, shopper.uid);
    } else if(prize.type === 'airtime'){
      await sendReloadlyAirtime(phone, finalNetwork, prize.value);
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id, shopper.uid);
    } else if(prize.type === 'data'){
      await sendReloadlyData(phone, finalNetwork, prize.value);
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id, shopper.uid);
    } else if(prize.type === 'freeship'){
      await db.collection('fulfillmentQueue').add({ phone, shopperUid:shopper.uid, type:'freeship_voucher', status:'pending', createdAt: new Date().toISOString() });
      await logSpinWinner(phone, name, 'Free Shipping Voucher', prize.id, shopper.uid);
    } else if(prize.type === 'earpods' && earpodTier){
      await db.collection('fulfillmentQueue').add({
        phone, shopperUid:shopper.uid, type:'earpods', earpodName: earpodTier.name, earpodValue: earpodTier.value,
        freeShipping, status:'pending', createdAt: new Date().toISOString()
      });
      await logSpinWinner(phone, name, `${earpodTier.name}${freeShipping?' (Free Shipping)':''}`, prize.id, shopper.uid);
    } else if(prize.type === 'coupon'){
      await db.collection('fulfillmentQueue').add({ phone, shopperUid:shopper.uid, type:'coupon', status:'pending', createdAt: new Date().toISOString() });
      await logSpinWinner(phone, name, '10% Off Coupon', prize.id, shopper.uid);
    }
  } catch(err){
    await db.collection('fulfillmentQueue').add({ phone, shopperUid:shopper.uid, type: prize.type, value: prize.value, status:'failed', error: err.message, createdAt: new Date().toISOString() });
  }

  res.json({ prize: prize.id, earpodName: earpodTier ? earpodTier.name : null, freeShipping });
});

// ---------- RELOADLY ----------
let reloadlyToken = null, reloadlyTokenExpiry = 0;
async function getReloadlyToken(){
  if(reloadlyToken && Date.now() < reloadlyTokenExpiry) return reloadlyToken;
  const resp = await axios.post('https://auth.reloadly.com/oauth/token', {
    client_id: RELOADLY_CLIENT_ID,
    client_secret: RELOADLY_CLIENT_SECRET,
    grant_type: 'client_credentials',
    audience: 'https://topups.reloadly.com'
  });
  reloadlyToken = resp.data.access_token;
  reloadlyTokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return reloadlyToken;
}
const OPERATOR_IDS = { MTN: 341, TELECEL: 342, AT: 343 }; // confirm real Ghana operator IDs in your Reloadly dashboard
async function sendReloadlyAirtime(phone, network, amountGHC){
  const token = await getReloadlyToken();
  await axios.post('https://topups.reloadly.com/topups', {
    operatorId: OPERATOR_IDS[network],
    amount: amountGHC,
    useLocalAmount: true,
    recipientPhone: { countryCode:'GH', number: phone }
  }, { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } });
}
async function sendReloadlyData(phone, network, amountMB){
  const token = await getReloadlyToken();
  await axios.post('https://topups.reloadly.com/topups', {
    operatorId: OPERATOR_IDS[network],
    amount: amountMB >= 1000 ? 5 : 3, // placeholder — replace with real data-plan IDs
    useLocalAmount: true,
    recipientPhone: { countryCode:'GH', number: phone }
  }, { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } });
}

// ---------- BUY COINS ----------
// Records the REQUEST for a purchase only. Price and coin quantity are defined by the
// server (payments.js); `coins` / `priceGHC` from the browser are kept for audit and
// never used to decide what a payment is worth.
app.post('/api/buy-coins', async (req,res)=>{
  const shopper = await requireVerifiedShopper(req,res,req.body && req.body.phone);
  if(!shopper) return;
  try{
    const r = await payments.handleBuyCoins(payDeps, { ...(req.body || {}), phone: shopper.walletPhone }, shopper);
    res.status(r.http).json(r.json);
  } catch(err){
    console.error('buy-coins failed:', err.message);
    res.status(500).json({ error:'Could not record purchase' });
  }
});

// ---------- VERIFY & CREDIT — primary crediting path. Shares ONE idempotent credit
// function with the webhook, so a purchase can only ever be credited once. ----------
app.post('/api/verify-purchase', async (req,res)=>{
  const shopper = await requireVerifiedShopper(req,res,null);
  if(!shopper) return;
  try{
    const r = await payments.handleVerifyPurchase(payDeps, req.body || {}, shopper);
    res.status(r.http).json(r.json);
  } catch(err){
    console.error('Verify purchase failed:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ---------- PAYSTACK WEBHOOK — backup path. Signature-checked, then uses the same
// idempotent credit function as /api/verify-purchase ----------
app.post('/api/paystack-webhook', async (req,res)=>{
  try{
    const r = await payments.handleWebhook(payDeps, {
      rawBody: req.body,
      signature: req.headers['x-paystack-signature']
    });
    res.status(r.http).send(r.text);
  } catch(err){
    console.error('Webhook failed:', err.message);
    res.sendStatus(500);
  }
});

app.get('/', (req,res)=> res.send('Voltix Spin Backend running'));

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Spin backend running on port ${PORT}`));
}
module.exports = app;
