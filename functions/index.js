const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Razorpay = require('razorpay');
const crypto = require('crypto');
initializeApp(); const db=getFirestore();
const RZP_KEY_ID=defineSecret('RAZORPAY_KEY_ID'); const RZP_KEY_SECRET=defineSecret('RAZORPAY_KEY_SECRET'); const RZP_WEBHOOK_SECRET=defineSecret('RAZORPAY_WEBHOOK_SECRET');
// Keep this map in sync with the storefront catalogue. Server values are authoritative.
const CATALOG={
'Hooded Puffer Vest – White & Teal':1299,'Quilted Puffer Vests – Neutral Collection':999,'Motorsport Track Jacket':1699,'Colour Pop Zip-Up Jackets':1299,'Winter Hooded Puffer Jacket':2999,'Hooded Puffer Vests – Sport Collection':1999,'Quilted Puffer Vests – Classic Colours':1599,'Motorsport Puffer Jackets':1999,'Graphic Puffer Vest – Blue':1199,'Hooded Puffer Vests – Multi-Colour':1499,'Colourblock Track Jackets':1799,'Utility Overshirt Jackets':2199,'Hooded Puffer Vests – Longline':1799,'Hooded Puffer Vests – Essential Colours':1499};
const ALLOWED=['M','L','XL','XXL'];
// Configure a real below-threshold shipping fee before deployment. Do not guess it.
const SHIPPING_FEE_PAISE=process.env.SHIPPING_FEE_PAISE ? Number(process.env.SHIPPING_FEE_PAISE) : null;
function validate(data,uid){
 const c=data.customer||{}; if(!c.name||!/^\d{10}$/.test(c.phone||'')||!/^\S+@\S+\.\S+$/.test(c.email||'')||!c.address||!c.city||!c.state||!/^\d{6}$/.test(c.pin||'')) throw new HttpsError('invalid-argument','Please provide complete and valid delivery details.');
 if(!Array.isArray(data.items)||!data.items.length||data.items.length>30) throw new HttpsError('invalid-argument','Your cart is empty or invalid.');
 let subtotal=0; const items=data.items.map(i=>{const price=CATALOG[i.name]; if(!price||!Number.isInteger(i.qty)||i.qty<1||i.qty>10||!ALLOWED.includes(i.size)) throw new HttpsError('invalid-argument','One or more cart items are invalid.'); subtotal+=price*i.qty; return {name:i.name,price,qty:i.qty,size:i.size};});
 if(subtotal<1999 && SHIPPING_FEE_PAISE===null) throw new HttpsError('failed-precondition','Shipping charge for orders below ₹1,999 has not been configured yet. Please contact VOZRIK support.');
 const shipping=subtotal>=1999?0:Math.round(SHIPPING_FEE_PAISE/100); return {items,customer:c,subtotal,shipping,total:subtotal+shipping};
}
async function newOrder(uid,v,paymentMethod,status){const ref=db.collection('orders').doc(); await ref.set({uid,items:v.items,customer:v.customer,subtotal:v.subtotal,shipping:v.shipping,total:v.total,paymentMethod,status,fulfillmentStatus:'new',createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()}); return ref.id;}
exports.placeCodOrder=onCall({region:'asia-south1'},async req=>{if(!req.auth)throw new HttpsError('unauthenticated','Please sign in first.');const v=validate(req.data,req.auth.uid);const id=await newOrder(req.auth.uid,v,'cod','confirmed_cod');return {orderId:id,total:v.total};});
exports.createRazorpayOrder=onCall({region:'asia-south1',secrets:[RZP_KEY_ID,RZP_KEY_SECRET]},async req=>{if(!req.auth)throw new HttpsError('unauthenticated','Please sign in first.');const v=validate(req.data,req.auth.uid);const id=await newOrder(req.auth.uid,v,'razorpay','payment_pending');const rz=new Razorpay({key_id:RZP_KEY_ID.value(),key_secret:RZP_KEY_SECRET.value()});try{const order=await rz.orders.create({amount:v.total*100,currency:'INR',receipt:id,notes:{firebaseOrderId:id,uid:req.auth.uid}});await db.collection('orders').doc(id).update({razorpayOrderId:order.id});return {orderId:id,razorpayOrderId:order.id,amount:order.amount,keyId:RZP_KEY_ID.value()};}catch(e){await db.collection('orders').doc(id).update({status:'payment_init_failed'});throw new HttpsError('internal','Could not start online payment.');}});
exports.verifyRazorpayPayment=onCall({region:'asia-south1',secrets:[RZP_KEY_SECRET]},async req=>{if(!req.auth)throw new HttpsError('unauthenticated','Please sign in first.');const {razorpay_order_id,razorpay_payment_id,razorpay_signature,orderId}=req.data||{};const ref=db.collection('orders').doc(orderId);const snap=await ref.get();if(!snap.exists||snap.data().uid!==req.auth.uid||snap.data().razorpayOrderId!==razorpay_order_id)throw new HttpsError('permission-denied','Order does not match this account.');const expected=crypto.createHmac('sha256',RZP_KEY_SECRET.value()).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');if(Buffer.byteLength(expected)!==Buffer.byteLength(razorpay_signature||'')||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpay_signature||'')))throw new HttpsError('permission-denied','Payment signature verification failed.');const rz=new Razorpay({key_id:RZP_KEY_ID.value(),key_secret:RZP_KEY_SECRET.value()});const payment=await rz.payments.fetch(razorpay_payment_id);if(payment.order_id!==razorpay_order_id||payment.status!=='captured'||payment.currency!=='INR'||payment.amount!==snap.data().total*100)throw new HttpsError('failed-precondition','Payment is not captured or does not match this order.');await ref.update({status:'paid',razorpayPaymentId:razorpay_payment_id,updatedAt:FieldValue.serverTimestamp()});return {orderId};});

// Razorpay Dashboard webhook endpoint: subscribe to order.paid and payment.captured.
// Set RAZORPAY_WEBHOOK_SECRET to the same secret configured in the Razorpay Dashboard.
exports.razorpayWebhook=onRequest({region:'asia-south1',secrets:[RZP_KEY_ID,RZP_KEY_SECRET,RZP_WEBHOOK_SECRET]},async(req,res)=>{
 if(req.method!=='POST'){res.status(405).send('Method not allowed');return;}
 const signature=req.get('x-razorpay-signature')||'';const expected=crypto.createHmac('sha256',RZP_WEBHOOK_SECRET.value()).update(req.rawBody).digest('hex');
 if(Buffer.byteLength(expected)!==Buffer.byteLength(signature)||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature))){res.status(401).send('Invalid signature');return;}
 try{const event=req.body?.event;if(!['order.paid','payment.captured'].includes(event)){res.status(200).send('Ignored');return;}
  const paymentEntity=req.body?.payload?.payment?.entity;const orderEntity=req.body?.payload?.order?.entity;const orderId=orderEntity?.id||paymentEntity?.order_id;const paymentId=paymentEntity?.id;
  if(!orderId||!paymentId){res.status(200).send('No payment data');return;}
  const rz=new Razorpay({key_id:RZP_KEY_ID.value(),key_secret:RZP_KEY_SECRET.value()});const [rzOrder,payment]=await Promise.all([rz.orders.fetch(orderId),rz.payments.fetch(paymentId)]);
  if(payment.order_id!==orderId||payment.status!=='captured'||payment.currency!=='INR'||payment.amount!==rzOrder.amount){res.status(200).send('Payment not captured or mismatched');return;}
  const receipt=rzOrder.receipt; if(!receipt){res.status(200).send('No receipt');return;}const ref=db.collection('orders').doc(receipt);const snap=await ref.get();
  if(snap.exists&&snap.data().razorpayOrderId===orderId&&snap.data().total*100===payment.amount){await ref.update({status:'paid',razorpayPaymentId:paymentId,updatedAt:FieldValue.serverTimestamp()});}
  res.status(200).send('OK');
 }catch(err){console.error('Razorpay webhook error',err);res.status(500).send('Webhook processing failed');}
});


// Admin operations use Firebase custom claims. Never grant the admin claim from the public website.
const ADMIN_FULFILLMENT_STATES = ['new','processing','packed','shipped','delivered','cancelled'];
exports.adminListOrders = onCall({region:'asia-south1'}, async req => {
  if (!req.auth || req.auth.token.admin !== true) throw new HttpsError('permission-denied','Admin access required.');
  const limit = Math.min(Math.max(Number(req.data?.limit) || 50, 1), 100);
  const snap = await db.collection('orders').orderBy('createdAt','desc').limit(limit).get();
  return { orders: snap.docs.map(d => {
    const x=d.data();
    return { id:d.id, uid:x.uid, items:x.items||[], customer:x.customer||{}, subtotal:x.subtotal||0, shipping:x.shipping||0, total:x.total||0, paymentMethod:x.paymentMethod||'', paymentStatus:x.status||'', fulfillmentStatus:x.fulfillmentStatus||'new', createdAt:x.createdAt?.toDate?.().toISOString()||null };
  }) };
});
exports.adminUpdateOrderFulfillment = onCall({region:'asia-south1'}, async req => {
  if (!req.auth || req.auth.token.admin !== true) throw new HttpsError('permission-denied','Admin access required.');
  const orderId=String(req.data?.orderId||''); const next=String(req.data?.fulfillmentStatus||'');
  if (!/^[A-Za-z0-9]{10,40}$/.test(orderId) || !ADMIN_FULFILLMENT_STATES.includes(next) || next==='new') throw new HttpsError('invalid-argument','Invalid order or fulfillment status.');
  const ref=db.collection('orders').doc(orderId); const snap=await ref.get();
  if (!snap.exists) throw new HttpsError('not-found','Order not found.');
  await ref.update({fulfillmentStatus:next,updatedAt:FieldValue.serverTimestamp()});
  return {orderId,fulfillmentStatus:next};
});
