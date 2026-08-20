const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

// Service account JSON pasted as one env var on Render (Firebase Console →
// Project Settings → Service Accounts → Generate new private key)
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const app = express();
app.use(cors());
// Paystack webhook needs the raw body for signature verification —
// everything else gets normal JSON parsing.
app.use('/api/paystack-webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

const SPIN_COST = 20;
const DAILY_SPIN_CAP = 10;

const PRIZES = [
  { id:'none',      weight:35,  type:'none' },
  { id:'coins5',    weight:20,  type:'coins',   value:5 },
  { id:'coins10',   weight:15,  type:'coins',   value:10 },
  { id:'airtime1',  weight:12,  type:'airtime', value:1 },
  { id:'airtime2',  weight:8,   type:'airtime', value:2 },
  { id:'data500mb', weight:5,   type:'data',    value:500 },
  { id:'airtime5',  weight:2.5, type:'airtime', value:5 },
  { id:'data1gb',   weight:1.5, type:'data',    value:1000 },
  { id:'coupon10',  weight:0.7, type:'coupon',  value:10 },
  { id:'earpods',   weight:0.3, type:'earpods' },
];
function pickPrize(){
  const total = PRIZES.reduce((s,p)=>s+p.weight,0);
  let r = Math.random()*total;
  for(const p of PRIZES){ if(r<p.weight) return p; r-=p.weight; }
  return PRIZES[0];
}

/* ---------- WALLET LOOKUP ---------- */
app.get('/api/wallet', async (req,res)=>{
  const { phone } = req.query;
  if(!phone) return res.status(400).json({ error:'phone required' });
  const snap = await db.collection('wallets').doc(phone).get();
  if(!snap.exists) return res.json({ coins: 0, network: null });
  res.json(snap.data());
});

/* ---------- SPIN ---------- */
app.post('/api/spin', async (req,res)=>{
  const { phone, network } = req.body;
  if(!phone) return res.status(400).json({ error:'phone required' });

  const walletRef = db.collection('wallets').doc(phone);
  const walletSnap = await walletRef.get();
  const wallet = walletSnap.exists ? walletSnap.data() : { coins: 0 };

  // Daily spin cap
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const spinsToday = await db.collection('spins')
    .where('phone','==',phone)
    .where('createdAt','>=', startOfDay.toISOString())
    .get();
  if(spinsToday.size >= DAILY_SPIN_CAP) return res.status(429).json({ error:'Daily spin limit reached' });

  if(wallet.coins < SPIN_COST) return res.status(400).json({ error:'Not enough coins' });

  const finalNetwork = network || wallet.network || 'MTN';
  await walletRef.set({ coins: admin.firestore.FieldValue.increment(-SPIN_COST), network: finalNetwork }, { merge:true });

  const prize = pickPrize();
  await db.collection('spins').add({ phone, prizeId: prize.id, network: finalNetwork, createdAt: new Date().toISOString() });

  try{
    if(prize.type === 'coins'){
      await walletRef.update({ coins: admin.firestore.FieldValue.increment(prize.value) });
    } else if(prize.type === 'airtime'){
      await sendReloadlyAirtime(phone, finalNetwork, prize.value);
    } else if(prize.type === 'data'){
      await sendReloadlyData(phone, finalNetwork, prize.value);
    } else if(prize.type === 'earpods' || prize.type === 'coupon'){
      await db.collection('fulfillmentQueue').add({
        phone, type: prize.type, status: 'pending', createdAt: new Date().toISOString()
      });
    }
  } catch(err){
    // Fulfillment failed (e.g. Reloadly down) — still tell the user they won,
    // but flag it for manual follow-up so nobody misses their prize.
    await db.collection('fulfillmentQueue').add({
      phone, type: prize.type, value: prize.value, status:'failed', error: err.message, createdAt: new Date().toISOString()
    });
  }

  res.json({ prize: prize.id });
});

/* ---------- RELOADLY ---------- */
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
const OPERATOR_IDS = { MTN: 341, TELECEL: 342, AT: 343 }; // placeholder — confirm real Ghana operator IDs in your Reloadly dashboard before going live
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
  // Reloadly data bundles are looked up per operator via their "data plans" endpoint —
  // this is a stub until you confirm exact bundle IDs for MTN/Telecel/AT in Ghana.
  const token = await getReloadlyToken();
  await axios.post('https://topups.reloadly.com/topups', {
    operatorId: OPERATOR_IDS[network],
    amount: amountMB >= 1000 ? 5 : 3, // placeholder mapping — replace with real data-plan IDs
    useLocalAmount: true,
    recipientPhone: { countryCode:'GH', number: phone }
  }, { headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' } });
}

/* ---------- BUY COINS: create a pending record, webhook confirms it ---------- */
app.post('/api/buy-coins', async (req,res)=>{
  const { phone, coins, ref } = req.body;
  await db.collection('coinPurchases').doc(ref).set({
    phone, coins, status:'pending', createdAt: new Date().toISOString()
  });
  res.json({ status:'pending' });
});

/* ---------- PAYSTACK WEBHOOK — the ONLY place coins actually get credited ---------- */
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
      const { phone, coins } = purchaseSnap.data();
      await db.collection('wallets').doc(phone).set({
        coins: admin.firestore.FieldValue.increment(coins)
      }, { merge:true });
      await purchaseRef.update({ status:'confirmed', confirmedAt: new Date().toISOString() });
    }
  }
  res.sendStatus(200);
});

app.get('/', (req,res)=> res.send('Voltix Spin Backend running'));

// Vercel runs this as a serverless function, so we export the app instead
// of calling app.listen(). Locally/on Render, PORT will be set and it still
// listens normally — this works either way.
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Spin backend running on port ${PORT}`));
}
module.exports = app;
