// Earpod tiers, ordered by spend requirement
const EARPOD_TIERS = [
  { id:'earpod_single',    name:'Single Earpod',    value:40,  unlockSpend:80,  freeShipSpend:120 },
  { id:'earpod_ultrapods', name:'Ultrapods',        value:120, unlockSpend:150, freeShipSpend:180 },
  { id:'earpod_openear',   name:'Berlin Open-Ear',  value:130, unlockSpend:170, freeShipSpend:200 },
  { id:'earpod_sporthook', name:'Sport Hook',       value:220, unlockSpend:260, freeShipSpend:270 },
];

function getEligibleEarpodTier(totalSpend){
  // Highest tier the user currently qualifies for, or null if none yet
  let eligible = null;
  for(const tier of EARPOD_TIERS){
    if(totalSpend >= tier.unlockSpend) eligible = tier;
  }
  return eligible;
}

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

app.post('/api/spin', async (req,res)=>{
  const { phone, network } = req.body;
  if(!phone) return res.status(400).json({ error:'phone required' });

  const walletRef = db.collection('wallets').doc(phone);
  const walletSnap = await walletRef.get();
  const wallet = walletSnap.exists ? walletSnap.data() : { coins: 0, totalSpend: 0 };

  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const spinsToday = await db.collection('spins')
    .where('phone','==',phone)
    .where('createdAt','>=', startOfDay.toISOString())
    .get();
  if(spinsToday.size >= 10) return res.status(429).json({ error:'Daily spin limit reached' });

  if(wallet.coins < 20) return res.status(400).json({ error:'Not enough coins' });

  const finalNetwork = network || wallet.network || 'MTN';
  await walletRef.set({ coins: admin.firestore.FieldValue.increment(-20), network: finalNetwork }, { merge:true });

  let prize = pickPrize();

  // If they landed on earpods but haven't unlocked any tier yet,
  // quietly convert it to a coin refund instead — never show a broken win.
  const totalSpend = wallet.totalSpend || 0;
  let earpodTier = null;
  let freeShipping = false;
  if(prize.type === 'earpods'){
    earpodTier = getEligibleEarpodTier(totalSpend);
    if(!earpodTier){
      prize = { id:'coins10', type:'coins', value:10 }; // fallback, feels like a normal win
    } else {
      freeShipping = totalSpend >= earpodTier.freeShipSpend;
    }
  }

  await db.collection('spins').add({ phone, prizeId: prize.id, network: finalNetwork, createdAt: new Date().toISOString() });

  try{
    if(prize.type === 'coins'){
      await walletRef.update({ coins: admin.firestore.FieldValue.increment(prize.value) });
    } else if(prize.type === 'airtime'){
      await sendReloadlyAirtime(phone, finalNetwork, prize.value);
    } else if(prize.type === 'data'){
      await sendReloadlyData(phone, finalNetwork, prize.value);
    } else if(prize.type === 'freeship'){
      await db.collection('fulfillmentQueue').add({
        phone, type:'freeship_voucher', status:'pending', createdAt: new Date().toISOString()
      });
    } else if(prize.type === 'earpods' && earpodTier){
      await db.collection('fulfillmentQueue').add({
        phone, type:'earpods', earpodName: earpodTier.name, earpodValue: earpodTier.value,
        freeShipping, status:'pending', createdAt: new Date().toISOString()
      });
    } else if(prize.type === 'coupon'){
      await db.collection('fulfillmentQueue').add({
        phone, type:'coupon', status:'pending', createdAt: new Date().toISOString()
      });
    }
  } catch(err){
    await db.collection('fulfillmentQueue').add({
      phone, type: prize.type, value: prize.value, status:'failed', error: err.message, createdAt: new Date().toISOString()
    });
  }

  res.json({
    prize: prize.id,
    earpodName: earpodTier ? earpodTier.name : null,
    freeShipping
  });
});

// Track cumulative spend on every confirmed coin purchase
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
      const { phone, coins, priceGHC } = purchaseSnap.data();
      await db.collection('wallets').doc(phone).set({
        coins: admin.firestore.FieldValue.increment(coins),
        totalSpend: admin.firestore.FieldValue.increment(priceGHC || 0)
      }, { merge:true });
      await purchaseRef.update({ status:'confirmed', confirmedAt: new Date().toISOString() });
    }
  }
  res.sendStatus(200);
});

// Must now record priceGHC so the webhook can add it to totalSpend
app.post('/api/buy-coins', async (req,res)=>{
  const { phone, coins, ref, priceGHC } = req.body;
  await db.collection('coinPurchases').doc(ref).set({
    phone, coins, priceGHC: priceGHC || 0, status:'pending', createdAt: new Date().toISOString()
  });
  res.json({ status:'pending' });
});
