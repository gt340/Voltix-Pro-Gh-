const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use('/api/paystack-webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

const SPIN_COST = 20;
const DAILY_SPIN_CAP = 10;

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
  { id:'none',        weight:30, type:'none' },
  { id:'coins5',      weight:20, type:'coins',   value:5 },
  { id:'coins10',     weight:15, type:'coins',   value:10 },
  { id:'airtime1',    weight:12, type:'airtime', value:1 },
  { id:'airtime2',    weight:8,  type:'airtime', value:2 },
  { id:'data500mb',   weight:5,  type:'data',    value:500 },
  { id:'airtime5',    weight:2.5,type:'airtime', value:5 },
  { id:'data1gb',     weight:1.5,type:'data',    value:1000 },
  { id:'coupon10',    weight:0.7,type:'coupon',  value:10 },
  { id:'freeshipping',weight:2,  type:'freeship' },
  { id:'earpods',     weight:3.3,type:'earpods' },
];
function pickPrize(){
  const total = PRIZES.reduce((s,p)=>s+p.weight,0);
  let r = Math.random()*total;
  for(const p of PRIZES){ if(r<p.weight) return p; r-=p.weight; }
  return PRIZES[0];
}

const prizeLabelMap = {
  coins5:'5 Coins', coins10:'10 Coins', airtime1:'Ghc1 Airtime', airtime2:'Ghc2 Airtime',
  airtime5:'Ghc5 Airtime', data500mb:'500MB Data', data1gb:'1GB Data', coupon10:'10% Off Coupon',
  freeshipping:'Free Shipping Voucher'
};

// ---------- WALLET LOOKUP ----------
app.get('/api/wallet', async (req,res)=>{
  const { phone } = req.query;
  if(!phone) return res.status(400).json({ error:'phone required' });
  const snap = await db.collection('wallets').doc(phone).get();
  if(!snap.exists) return res.json({ coins: 0, network: null, totalSpend: 0 });
  const data = snap.data();
  res.json({ coins: data.coins || 0, network: data.network || null, totalSpend: data.totalSpend || 0 });
});

// ---------- SPIN REFERRAL CODES ----------
function generateReferralCode(phone){
  return 'VLX' + phone.replace(/\D/g,'').slice(-4) + Math.random().toString(36).slice(2,5).toUpperCase();
}
app.get('/api/spin-referral-code', async (req,res)=>{
  const { phone } = req.query;
  if(!phone) return res.status(400).json({ error:'phone required' });
  const walletRef = db.collection('wallets').doc(phone);
  const snap = await walletRef.get();
  const existing = snap.exists ? snap.data().spinReferralCode : null;
  if(existing) return res.json({ code: existing });

  const code = generateReferralCode(phone);
  await walletRef.set({ spinReferralCode: code }, { merge:true });
  await db.collection('spinReferralCodes').doc(code).set({ phone });
  res.json({ code });
});

// ---------- SPIN WINNERS LOG (admin dashboard) ----------
async function logSpinWinner(phone, name, prizeLabel, prizeId){
  await db.collection('spinWinners').add({
    phone, name: name || 'Unknown', prizeLabel, prizeId,
    status: 'pending', createdAt: new Date().toISOString()
  });
}
app.post('/api/mark-winner-fulfilled', async (req,res)=>{
  const { winnerId } = req.body;
  await db.collection('spinWinners').doc(winnerId).update({ status:'fulfilled' });
  res.json({ status:'ok' });
});

// ---------- SPIN ----------
app.post('/api/spin', async (req,res)=>{
  const { phone, network, name } = req.body;
  if(!phone) return res.status(400).json({ error:'phone required' });

  const walletRef = db.collection('wallets').doc(phone);
  const walletSnap = await walletRef.get();
  const wallet = walletSnap.exists ? walletSnap.data() : { coins: 0, totalSpend: 0 };

  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const spinsToday = await db.collection('spins')
    .where('phone','==',phone)
    .where('createdAt','>=', startOfDay.toISOString())
    .get();
  if(spinsToday.size >= DAILY_SPIN_CAP) return res.status(429).json({ error:'Daily spin limit reached' });
  if(wallet.coins < SPIN_COST) return res.status(400).json({ error:'Not enough coins' });

  const finalNetwork = network || wallet.network || 'MTN';
  const updateData = { coins: admin.firestore.FieldValue.increment(-SPIN_COST), network: finalNetwork };
  if(name) updateData.name = name;
  await walletRef.set(updateData, { merge:true });

  let prize = pickPrize();
  const totalSpend = wallet.totalSpend || 0;
  let earpodTier = null;
  let freeShipping = false;
  if(prize.type === 'earpods'){
    earpodTier = getEligibleEarpodTier(totalSpend);
    if(!earpodTier){ prize = { id:'coins10', type:'coins', value:10 }; }
    else { freeShipping = totalSpend >= earpodTier.freeShipSpend; }
  }

  await db.collection('spins').add({ phone, prizeId: prize.id, network: finalNetwork, createdAt: new Date().toISOString() });

  try{
    if(prize.type === 'coins'){
      await walletRef.update({ coins: admin.firestore.FieldValue.increment(prize.value) });
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id);
    } else if(prize.type === 'airtime'){
      await sendReloadlyAirtime(phone, finalNetwork, prize.value);
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id);
    } else if(prize.type === 'data'){
      await sendReloadlyData(phone, finalNetwork, prize.value);
      await logSpinWinner(phone, name, prizeLabelMap[prize.id], prize.id);
    } else if(prize.type === 'freeship'){
      await db.collection('fulfillmentQueue').add({ phone, type:'freeship_voucher', status:'pending', createdAt: new Date().toISOString() });
      await logSpinWinner(phone, name, 'Free Shipping Voucher', prize.id);
    } else if(prize.type === 'earpods' && earpodTier){
      await db.collection('fulfillmentQueue').add({
        phone, type:'earpods', earpodName: earpodTier.name, earpodValue: earpodTier.value,
        freeShipping, status:'pending', createdAt: new Date().toISOString()
      });
      await logSpinWinner(phone, name, `${earpodTier.name}${freeShipping?' (Free Shipping)':''}`, prize.id);
    } else if(prize.type === 'coupon'){
      await db.collection('fulfillmentQueue').add({ phone, type:'coupon', status:'pending', createdAt: new Date().toISOString() });
      await logSpinWinner(phone, name, '10% Off Coupon', prize.id);
    }
  } catch(err){
    await db.collection('fulfillmentQueue').add({ phone, type: prize.type, value: prize.value, status:'failed', error: err.message, createdAt: new Date().toISOString() });
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
app.post('/api/buy-coins', async (req,res)=>{
  const { phone, coins, ref, priceGHC, spinRefCode } = req.body;
  await db.collection('coinPurchases').doc(ref).set({
    phone, coins, priceGHC: priceGHC || 0, spinRefCode: spinRefCode || null,
    status:'pending', createdAt: new Date().toISOString()
  });
  res.json({ status:'pending' });
});

// ---------- PAYSTACK WEBHOOK ----------
app.post('/api/paystack-webhook', async (req,res)=>{
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if(hash !== signature) return res.status(401).send('Invalid signature');

  const event = JSON.parse(req.body);
  if(event.event === 'charge.success'){
    const ref = event.data.reference;
    const purchaseRef = db.collection('coinPurchases').doc(ref);
    const purchaseSnap = await purchaseRef.get();
    if(purchaseSnap.exists && purchaseSnap.data().status === 'pending'){
      const { phone, coins, priceGHC, spinRefCode } = purchaseSnap.data();
      const walletRef = db.collection('wallets').doc(phone);
      const walletSnap = await walletRef.get();
      const wasFirstPurchase = !walletSnap.exists || !walletSnap.data().hasPurchasedBefore;

      await walletRef.set({
        coins: admin.firestore.FieldValue.increment(coins),
        totalSpend: admin.firestore.FieldValue.increment(priceGHC || 0),
        hasPurchasedBefore: true
      }, { merge:true });
      await purchaseRef.update({ status:'confirmed', confirmedAt: new Date().toISOString() });

      if(wasFirstPurchase && (priceGHC || 0) >= 10 && spinRefCode){
        const codeSnap = await db.collection('spinReferralCodes').doc(spinRefCode).get();
        if(codeSnap.exists){
          const referrerPhone = codeSnap.data().phone;
          if(referrerPhone !== phone){
            const existingReward = await db.collection('spinReferrals')
              .where('referredPhone','==',phone).where('status','==','rewarded').get();
            if(existingReward.empty){
              await db.collection('wallets').doc(referrerPhone).set({ coins: admin.firestore.FieldValue.increment(40) }, { merge:true });
              await walletRef.set({ coins: admin.firestore.FieldValue.increment(40) }, { merge:true });
              await db.collection('spinReferrals').add({
                referrerPhone, referredPhone: phone, status:'rewarded', rewardedAt: new Date().toISOString()
              });
            }
          }
        }
      }
    }
  }
  res.sendStatus(200);
});

app.get('/', (req,res)=> res.send('Voltix Spin Backend running'));

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Spin backend running on port ${PORT}`));
}
module.exports = app;
