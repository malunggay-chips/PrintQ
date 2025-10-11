// index.js - Node/Express server
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer(); // memory storage

// ENV: set these in Render / Supabase / your host
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'prints';
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET; // paymongo secret key

if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}
if(!PAYMONGO_SECRET){
  console.warn('Warning: PAYMONGO_SECRET not set. Checkout creation will fail until set.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// utility to generate Print-XXXX
function generatePrintId(){
  const n = Math.floor(Math.random()*9000)+1000;
  return `Print-${n}`;
}

app.post('/api/create-print', upload.array('files'), async (req, res) => {
  try{
    const {
      name, phone, pages, copies, color, fulfill, location, amount
    } = req.body;

    if(!req.files || !req.files.length) return res.status(400).send('No files uploaded');
    if(!name || !phone) return res.status(400).send('Missing name or phone');

    // create unique print id (ensure uniqueness by loop-check - simple approach)
    let printId = generatePrintId();
    // quick check - if exists, regenerate up to 5 attempts
    for(let i=0;i<5;i++){
      const { data:exists } = await supabase.from('prints').select('id').eq('print_id', printId).limit(1);
      if(!exists || !exists.length) break;
      printId = generatePrintId();
    }

    // upload each file to storage and collect public URLs
    const fileUrls = [];
    for(const f of req.files){
      // generate safe filename
      const timestamp = Date.now();
      const random = crypto.randomBytes(3).toString('hex');
      const original = f.originalname.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9._-]/g,'');
      const path = `${printId}/${timestamp}_${random}_${original}`;

      // upload
      const { data, error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(path, f.buffer, { contentType: f.mimetype });

      if(error){
        console.error('Upload error', error);
        return res.status(500).send('File upload failed');
      }

      // create public URL (you can generate signed URL if privacy needed)
      const publicUrl = `${SUPABASE_URL.replace(/\/$/,'')}/storage/v1/object/public/${SUPABASE_BUCKET}/${encodeURIComponent(path)}`;
      fileUrls.push(publicUrl);
    }

    // insert record into prints table
    const now = new Date().toISOString();
    const print_code = null;
    const { data: insertData, error: insertErr } = await supabase.from('prints').insert([{
      print_id: printId,
      name,
      phone,
      pages: Number(pages) || 1,
      copies: Number(copies) || 1,
      color,
      fulfill,
      location: location || null,
      files: fileUrls,
      amount: Number(amount) || 0,
      payment_status: 'Unpaid',
      print_status: 'Pending',
      notification: null,
      print_code,
      created_at: now
    }]).select().single();

    if(insertErr){
      console.error('Insert error', insertErr);
      return res.status(500).send('Database insert failed');
    }

    res.json({ printId, amount: Number(amount) || 0, recordId: insertData.id });
  }catch(err){
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Create PayMongo Checkout session (server-side)
app.post('/api/create-checkout', async (req,res)=>{
  try{
    const { printId, amount, email } = req.body;
    if(!printId || !amount || !email) return res.status(400).send('Missing parameters');

    // PayMongo requires amounts in centavos (PHP * 100)
    const amt = Math.round(Number(amount) * 100);

    // Create checkout session with PayMongo
    // Reference: PayMongo Checkout API - create checkout session
    const payload = {
      data: {
        attributes: {
          amount: amt,
          // currency default PHP
          currency: 'PHP',
          description: `PrintQ - ${printId}`,
          // merchant_defined or redirect urls
          // set success and failed return URLs (adjust to your frontend)
          success_url: process.env.SUCCESS_URL || 'https://your-site.example/success',
          cancel_url: process.env.CANCEL_URL || 'https://your-site.example/cancel',
          metadata: {
            print_id: printId,
            email
          },
          // optionally, allowed payment methods could be specified
        }
      }
    };

    const r = await axios.post('https://api.paymongo.com/v1/checkout_sessions', payload, {
      auth: { username: PAYMONGO_SECRET, password: '' },
      headers: { 'Content-Type': 'application/json' }
    });

    // expected: r.data.data.attributes.checkout_url
    const checkoutUrl = r.data?.data?.attributes?.checkout_url;
    if(!checkoutUrl) return res.status(500).send('No checkout url returned by PayMongo');

    // store checkout session id with print record (optional)
    await supabase.from('prints').update({ checkout_url: checkoutUrl }).eq('print_id', printId);

    res.json({ checkout_url: checkoutUrl });
  }catch(err){
    console.error('Create checkout error', err.response?.data || err.message || err);
    res.status(500).send('Failed to create checkout session');
  }
});

// Endpoint to fetch status by printId (used by frontend)
app.get('/api/get-status', async (req,res)=>{
  try{
    const { printId } = req.query;
    if(!printId) return res.status(400).send('Missing printId');
    const { data, error } = await supabase.from('prints').select('*').eq('print_id', printId).single();
    if(error) return res.status(404).send('Not found');
    res.json({
      print_code: data.print_code,
      payment_status: data.payment_status,
      print_status: data.print_status,
      notification: data.notification
    });
  }catch(err){
    console.error(err);
    res.status(500).send('Server error');
  }
});

/**
 * Webhook to receive PayMongo events.
 * You'll need to configure PayMongo to call this endpoint when checkout completes or payment succeeded/failed.
 * For security: verify webhook signatures if PayMongo provides them (see PayMongo docs).
 * Here we accept a simple webhook and update the Supabase record accordingly.
 */
app.post('/api/paymongo-webhook', async (req,res)=>{
  try{
    const body = req.body;
    // Simple example: inspect object type and status
    const eventType = body?.data?.type || body?.type || 'unknown';

    // attempt to find print_id from metadata
    const metadata = body?.data?.attributes?.metadata || {};
    const printId = metadata.print_id || (body?.data?.attributes?.description && body?.data?.attributes?.description.replace('PrintQ - ',''));
    // Determine payment status from event (this depends on PayMongo event payload)
    // This mapping might need adjustments based on PayMongo webhook payload specifics.
    const paymentStatus = (body?.data?.attributes?.status === 'succeeded' || body?.data?.attributes?.status === 'paid') ? 'Paid' : (body?.data?.attributes?.status === 'failed' ? 'Rejected' : null);

    if(printId && paymentStatus){
      const print_code = `${metadata?.name || 'User'}-${new Date().toISOString()}`;
      const print_status = paymentStatus === 'Paid' ? 'Approved' : 'Rejected';
      const notification = paymentStatus === 'Paid' ? (await markReadyOrOnTheWay(printId)) : null;

      await supabase.from('prints').update({
        payment_status: paymentStatus === 'Paid' ? 'Paid' : 'Unpaid',
        print_status,
        print_code,
        notification
      }).eq('print_id', printId);

      return res.status(200).send('ok');
    }

    return res.status(200).send('ignored');
  }catch(err){
    console.error('webhook error', err);
    res.status(500).send('server error');
  }
});

// Example: set notification based on fulfillment
async function markReadyOrOnTheWay(printId){
  const { data } = await supabase.from('prints').select('fulfill,name').eq('print_id', printId).single();
  if(!data) return null;
  if(data.fulfill === 'pickup') return 'Ready for pickup';
  return 'On the way';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server running on port', PORT));
