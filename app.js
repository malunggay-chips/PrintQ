// app.js
const calcBtn = document.getElementById('calcBtn');
const uploadPayBtn = document.getElementById('uploadPayBtn');
const filesInput = document.getElementById('files');
const nameInput = document.getElementById('name');
const phoneInput = document.getElementById('phone');
const pagesInput = document.getElementById('pages');
const copiesInput = document.getElementById('copies');
const locationRow = document.getElementById('locationRow');
const locationInput = document.getElementById('location');
const calcResult = document.getElementById('calcResult');

const popup = document.getElementById('popup');
const printIdText = document.getElementById('printIdText');
const copyBtn = document.getElementById('copyBtn');
const closePopupBtn = document.getElementById('closePopupBtn');

const statusSection = document.getElementById('status-section');
const showStatusSectionBtn = document.getElementById('showStatusSection');
const checkStatusBtn = document.getElementById('checkStatusBtn');
const statusPrintId = document.getElementById('statusPrintId');
const statusResult = document.getElementById('statusResult');

const API_BASE = '' // If hosting server root+path, set here (e.g. https://your-render-app.com)

function getSelectedValue(name){
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

document.querySelectorAll('input[name="fulfill"]').forEach(r=>{
  r.addEventListener('change', ()=> {
    const v = getSelectedValue('fulfill');
    if(v === 'delivery'){
      locationRow.classList.remove('hidden');
      locationInput.required = true;
    } else {
      locationRow.classList.add('hidden');
      locationInput.required = false;
      locationInput.value = '';
    }
  });
});

function calculatePrice(){
  const pages = Number(pagesInput.value) || 0;
  const copies = Number(copiesInput.value) || 0;
  const color = getSelectedValue('color'); // bw or color
  const fulfill = getSelectedValue('fulfill');
  if(pages <=0 || copies <=0) return null;
  const per = color==='color' ? 10 : 5;
  let amount = pages * copies * per;
  if(fulfill === 'delivery') amount += 20;
  return amount;
}

calcBtn.addEventListener('click', (e)=>{
  e.preventDefault();
  const amount = calculatePrice();
  if(amount === null){
    calcResult.textContent = 'Please fill pages and copies.';
    uploadPayBtn.disabled = true;
    return;
  }
  calcResult.textContent = `Estimated total: ₱ ${amount.toFixed(2)}`;
  uploadPayBtn.disabled = false;
});

document.getElementById('printForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  uploadPayBtn.disabled = true;
  uploadPayBtn.textContent = 'Uploading...';

  // validate required
  if(!filesInput.files.length){
    alert('Please attach at least one file.');
    uploadPayBtn.disabled = false;
    uploadPayBtn.textContent = 'Upload & Pay';
    return;
  }
  if(!nameInput.value || !phoneInput.value){
    alert('Please provide name and phone.');
    uploadPayBtn.disabled = false;
    uploadPayBtn.textContent = 'Upload & Pay';
    return;
  }
  if(getSelectedValue('fulfill') === 'delivery' && !locationInput.value){
    alert('Delivery location required.');
    uploadPayBtn.disabled = false;
    uploadPayBtn.textContent = 'Upload & Pay';
    return;
  }

  const amount = calculatePrice();
  if(amount === null){
    alert('Please calculate price first.');
    uploadPayBtn.disabled = false;
    uploadPayBtn.textContent = 'Upload & Pay';
    return;
  }

  // Build multipart form data
  const fd = new FormData();
  for(const f of filesInput.files) fd.append('files', f);
  fd.append('name', nameInput.value);
  fd.append('phone', phoneInput.value);
  fd.append('pages', pagesInput.value);
  fd.append('copies', copiesInput.value);
  fd.append('color', getSelectedValue('color'));
  fd.append('fulfill', getSelectedValue('fulfill'));
  fd.append('location', locationInput.value || '');
  fd.append('amount', amount); // pass to server

  try{
    const res = await fetch(API_BASE + '/api/create-print', {
      method: 'POST',
      body: fd
    });
    if(!res.ok) throw new Error('Server error while creating print.');
    const data = await res.json();
    // data should contain { printId, amount, recordId }
    printIdText.textContent = data.printId;
    popup.classList.remove('hidden');

    // Close popup manually — only after close we redirect to checkout
    closePopupBtn.onclick = async () => {
      popup.classList.add('hidden');
      // now create checkout
      const email = prompt('Please enter your email for the payment receipt:');
      if(!email){
        alert('Email required for payment.');
        return;
      }
      // call create-checkout to get checkout URL
      const ck = await fetch(API_BASE + '/api/create-checkout', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          printId: data.printId,
          amount: data.amount,
          email
        })
      });
      if(!ck.ok){
        const t = await ck.text();
        alert('Failed to create checkout: '+t);
        return;
      }
      const ckData = await ck.json();
      // ckData.checkout_url should be returned
      window.location.href = ckData.checkout_url;
    };
  }catch(err){
    console.error(err);
    alert('Error: '+err.message);
    uploadPayBtn.disabled = false;
    uploadPayBtn.textContent = 'Upload & Pay';
  }
});

copyBtn.addEventListener('click', ()=>{
  const txt = printIdText.textContent;
  navigator.clipboard?.writeText(txt).then(()=> {
    copyBtn.textContent = 'Copied';
    setTimeout(()=> copyBtn.textContent = 'Copy', 1500);
  }).catch(()=> alert('Copy failed'));
});

showStatusSectionBtn.addEventListener('click', ()=>{
  statusSection.classList.toggle('hidden');
  statusSection.classList.toggle('active');
  window.scrollTo({top:document.body.scrollHeight, behavior:'smooth'});
});

checkStatusBtn.addEventListener('click', async ()=>{
  const pid = statusPrintId.value.trim();
  if(!pid){ statusResult.textContent = 'Enter a Print ID.'; return; }
  statusResult.textContent = 'Fetching...';
  try{
    const r = await fetch(API_BASE + '/api/get-status?printId=' + encodeURIComponent(pid));
    if(!r.ok){ statusResult.textContent = 'Not found or server error.'; return; }
    const d = await r.json();
    // render result
    statusResult.innerHTML = `
      <p><strong>Print code:</strong> ${d.print_code || '—'}</p>
      <p><strong>Payment status:</strong> ${d.payment_status}</p>
      <p><strong>Print status:</strong> ${d.print_status}</p>
      <p><strong>Notification:</strong> ${d.notification || '—'}</p>
    `;
  }catch(err){
    statusResult.textContent = 'Error: '+err.message;
  }
});
