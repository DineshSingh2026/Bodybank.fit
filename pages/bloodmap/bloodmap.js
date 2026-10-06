/* BloodMap by BodyBank — the public page.
   Two modes on one URL: the landing + order form, and (with ?o=<token>) the
   client's own order: upload, progress, call slots, report. No login: the token
   in the private link is the credential. */
(function () {
  'use strict';

  var STORE_KEY = 'bloodmap_order';
  var MAX_TOTAL_BYTES = 20 * 1024 * 1024;
  var MAX_IMAGES = 6;
  var state = { cfg: null, token: '', view: null, files: [], poll: null };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Never throws: always resolves to { status, data }, and a failure carries data.error.
  function api(method, url, body) {
    var opts = { method: method, headers: { Accept: 'application/json' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
        if (!data || typeof data !== 'object') data = {};
        if (!res.ok && !data.error) data.error = 'Something went wrong (' + res.status + '). Please try again.';
        return { status: res.status, data: data };
      });
    }).catch(function () {
      return { status: 0, data: { error: 'Network error. Please check your connection and try again.' } };
    });
  }
  function orderUrl(path) { return '/api/bloodmap/order/' + encodeURIComponent(state.token) + (path || ''); }

  function showMsg(el, text, kind) {
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = 'msg' + (kind ? ' msg--' + kind : '');
    el.textContent = text;
    el.hidden = false;
  }

  function waLink(text) {
    var num = (state.view && state.view.whatsapp) || (state.cfg && state.cfg.whatsapp) || '';
    return 'https://wa.me/' + num + (text ? '?text=' + encodeURIComponent(text) : '');
  }

  var AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.8-3.9 3.8-6 7.5-6s6.700 2.100 7.500 6" stroke-linecap="round"/></svg>';
  function avatar(c, small) {
    var url = c && c.photo_url ? String(c.photo_url) : '';
    var safe = /^(https:\/\/|\/)[^"'()\s]+$/.test(url) ? url : '';
    return '<span class="avatar' + (small ? ' avatar--sm' : '') + '"' + (safe ? ' style="background-image:url(\'' + esc(safe) + '\')"' : '') + '>' + (safe ? '' : AVATAR) + '</span>';
  }

  /* ───────────────────────── landing ───────────────────────── */

  function paintConfig() {
    var c = state.cfg;
    if (!c) return;
    var price = '₹' + Number(c.price_rupees).toLocaleString('en-IN');
    Array.prototype.forEach.call(document.querySelectorAll('[data-price]'), function (el) { el.textContent = price; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-hours]'), function (el) { el.textContent = c.report_hours; });
    $('footWa').href = waLink('Hi, I have a question about BloodMap.');

    var secure = $('secureLine');
    if (c.dev_pay) secure.textContent = 'Local test mode: Razorpay keys are not set on this machine, so no real payment is taken.';
    else if (!c.pay_enabled) secure.textContent = 'Online payment is not available right now. Message us on WhatsApp and we will help.';
    else if (c.pay_mode === 'test') secure.textContent = 'Secure payment by Razorpay. Test mode: no real money is charged.';

    var ex = $('experts');
    var shown = ['doctor', 'nutritionist'].filter(function (role) { return c.consultants[role] && c.consultants[role].published; });
    $('expertsSec').hidden = !shown.length;
    if (ex) {
      ex.innerHTML = shown.map(function (role) {
        var p = c.consultants[role];
        return '<div class="card expert">' + avatar(p) + '<div>' +
          '<p class="role">' + esc(p.label) + '</p>' +
          '<h3 class="h3" style="margin-top:4px">' + esc(p.name) + '</h3>' +
          '<p class="qual">' + esc([p.title, p.qualification].filter(Boolean).join(' · ')) + '</p>' +
          (p.reg_no ? '<p class="reg">' + esc(p.reg_no) + '</p>' : '') +
          '<p>' + esc(p.bio) + '</p></div></div>';
      }).join('');
    }
  }

  var checkoutLoading = null;
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve();
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
      sc.onload = function () { resolve(); };
      sc.onerror = function () { checkoutLoading = null; reject(new Error('load')); };
      document.head.appendChild(sc);
    });
    return checkoutLoading;
  }

  function rememberToken(token) {
    state.token = token;
    try { localStorage.setItem(STORE_KEY, token); } catch (_) {}
    try { history.replaceState(null, '', '/bloodmap?o=' + encodeURIComponent(token)); } catch (_) {}
  }

  /** Runs the checkout described by `checkout`, then calls done(errorText|null). */
  function runCheckout(checkout, done) {
    if (checkout.paid) return done(null);
    if (checkout.dev) {
      return api('POST', orderUrl('/dev-pay')).then(function (r) { done(r.data.error || null); });
    }
    loadCheckout().then(function () {
      var settled = false;
      var rz = new window.Razorpay({
        key: checkout.key_id,
        order_id: checkout.order_id,
        amount: checkout.amount,
        currency: checkout.currency,
        name: 'BloodMap by BodyBank',
        description: 'Health Map report + doctor and sports nutritionist consultation',
        image: '/img/logo.png',
        prefill: checkout.prefill || {},
        theme: { color: '#c8a44e' },
        handler: function (resp) {
          settled = true;
          api('POST', orderUrl('/verify'), resp).then(function (r) {
            // A slow confirmation is not a failure: the dashboard polls until it clears.
            done(r.data.ok || r.data.pending ? null : (r.data.error || 'Payment could not be confirmed.'), !!r.data.pending);
          });
        },
        modal: { ondismiss: function () { if (!settled) done('Payment was not completed. You can try again whenever you are ready.'); } }
      });
      rz.open();
    }).catch(function () {
      done('Could not load the payment window. Please check your connection and try again.');
    });
  }

  function bindOrderForm() {
    var form = $('orderForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('payBtn');
      var msg = $('orderMsg');
      showMsg(msg, '');
      var body = {
        name: $('fName').value.trim(), phone: $('fPhone').value.trim(), email: $('fEmail').value.trim(),
        city: $('fCity').value.trim(), age: $('fAge').value.trim(), gender: $('fGender').value, consent: $('fConsent').checked
      };
      if (body.name.length < 2) return showMsg(msg, 'Please enter your full name.');
      if (body.phone.replace(/[^0-9]/g, '').length < 10) return showMsg(msg, 'Please enter a valid mobile number.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return showMsg(msg, 'Please enter a valid email address.');
      if (body.city.length < 2) return showMsg(msg, 'Please enter your city.');
      if (!(Number(body.age) >= 5 && Number(body.age) <= 110)) return showMsg(msg, 'Please enter your age.');
      if (!body.gender) return showMsg(msg, 'Please select your gender.');
      if (!body.consent) return showMsg(msg, 'Please tick the consent box to continue.');

      var price = state.cfg ? '₹' + Number(state.cfg.price_rupees).toLocaleString('en-IN') : '';
      var payLabel = 'Confirm and pay ' + price;
      var email = body.email.toLowerCase();

      // Step 1: prove the email. A code goes to it; nothing is ordered yet.
      function sendCode() {
        btn.disabled = true; btn.textContent = 'Sending your code…';
        api('POST', '/api/bloodmap/email/request', { email: email }).then(function (r) {
          btn.disabled = false;
          if (r.data.error) { btn.textContent = state.codeFor ? payLabel : 'Confirm my email'; return showMsg(msg, r.data.error); }
          state.codeFor = email;
          $('codeStep').hidden = false;
          $('codeInfo').textContent = 'We emailed a 6-digit code to ' + email + '. Enter it to confirm this is your email.' + (r.data.dev_code ? ' Local test code: ' + r.data.dev_code : '');
          $('fCode').value = '';
          btn.textContent = payLabel;
          try { $('fCode').focus(); } catch (_) {}
        });
      }
      $('codeResend').onclick = function (ev) { ev.preventDefault(); showMsg(msg, ''); sendCode(); };
      if (state.codeFor !== email) return sendCode();

      // Step 2: the code and the details go together; the server checks the code.
      body.email_code = $('fCode').value.replace(/[^0-9]/g, '');
      if (body.email_code.length !== 6) return showMsg(msg, 'Enter the 6-digit code we emailed you.');
      btn.disabled = true; btn.textContent = 'Starting…';
      var reset = function () { btn.disabled = false; btn.textContent = payLabel; };

      api('POST', '/api/bloodmap/order', body).then(function (r) {
        if (r.data.token) rememberToken(r.data.token);
        if (r.data.error || !r.data.checkout) { reset(); return showMsg(msg, r.data.error || 'Could not start your order.'); }
        runCheckout(r.data.checkout, function (err) {
          reset();
          // The order exists either way; the dashboard offers "complete payment" if unpaid.
          openOrder(err ? { notice: err } : null);
        });
      });
    });
  }

  /* ───────────────────────── tracking ───────────────────────── */

  function openModal(id) { $(id).classList.add('open'); }
  function closeModals() {
    Array.prototype.forEach.call(document.querySelectorAll('.modal.open'), function (m) { m.classList.remove('open'); });
  }

  function trackStepContact(prefill) {
    $('trackBody').innerHTML =
      '<div class="field"><label for="tContact">Email or mobile number</label><input id="tContact" autocomplete="email" maxlength="160" value="' + esc(prefill || '') + '"></div>' +
      '<p class="msg" id="tMsg" hidden></p>' +
      '<button class="btn btn--gold btn--block" type="button" id="tSend">Send my code</button>';
    $('tSend').onclick = function () {
      var contact = $('tContact').value.trim();
      if (!contact) return showMsg($('tMsg'), 'Enter the email or mobile number you used for your order.');
      this.disabled = true;
      api('POST', '/api/bloodmap/track/request', { contact: contact }).then(function (r) {
        if (r.data.error) { $('tSend').disabled = false; return showMsg($('tMsg'), r.data.error); }
        trackStepCode(contact, r.data);
      });
    };
  }

  function trackStepCode(contact, sent) {
    var where = 'If there is an order for that contact, a code is on its way to the email address on it.';
    $('trackBody').innerHTML =
      '<p class="msg msg--info">' + esc(where) + (sent.dev_code ? ' Local test code: ' + esc(sent.dev_code) : '') + '</p>' +
      '<div class="field"><label for="tCode">6-digit code</label><input id="tCode" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
      '<p class="msg" id="tMsg" hidden></p>' +
      '<button class="btn btn--gold btn--block" type="button" id="tVerify">Open my order</button>' +
      '<p class="small mute" style="margin-top:12px;text-align:center"><a href="#" id="tBack">Use a different email or number</a></p>';
    $('tBack').onclick = function (e) { e.preventDefault(); trackStepContact(contact); };
    $('tVerify').onclick = function () {
      var btn = this;
      btn.disabled = true;
      api('POST', '/api/bloodmap/track/verify', { contact: contact, code: $('tCode').value }).then(function (r) {
        btn.disabled = false;
        if (r.data.error) return showMsg($('tMsg'), r.data.error);
        var orders = r.data.orders || [];
        if (!orders.length) return showMsg($('tMsg'), 'We could not find a paid order for that contact.');
        if (orders.length === 1) { closeModals(); rememberToken(orders[0].token); return openOrder(); }
        $('trackBody').innerHTML = '<p class="small mute" style="margin-bottom:10px">You have more than one order. Choose one:</p>' + orders.map(function (o, i) {
          return '<button class="btn btn--block" style="margin-top:8px;justify-content:space-between" type="button" data-i="' + i + '"><span>' + esc(o.ref) + '</span><span class="small">' +
            esc(new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) + ' · ' + esc(STAGE_LABEL[o.stage] || o.stage) + '</span></button>';
        }).join('');
        Array.prototype.forEach.call($('trackBody').querySelectorAll('button[data-i]'), function (b) {
          b.onclick = function () { closeModals(); rememberToken(orders[Number(b.getAttribute('data-i'))].token); openOrder(); };
        });
      });
    };
    setTimeout(function () { try { $('tCode').focus(); } catch (_) {} }, 50);
  }

  function openTrack(e) {
    if (e) e.preventDefault();
    // A saved order on this device opens straight away; the code is for a new device.
    var saved = '';
    try { saved = localStorage.getItem(STORE_KEY) || ''; } catch (_) {}
    if (saved && !state.view) { state.token = saved; return openOrder({ fallbackToTrack: true }); }
    trackStepContact('');
    openModal('trackModal');
  }

  /* ───────────────────────── order dashboard ───────────────────────── */

  var STAGE_LABEL = {
    payment: 'Payment pending', upload: 'Waiting for your report', analysing: 'Analysing', review: 'Expert review',
    ready: 'Report ready', completed: 'Completed', refunded: 'Refunded'
  };
  var STAGE_PILL = { payment: 'warn', upload: 'warn', analysing: '', review: '', ready: 'ok', completed: 'ok', refunded: 'dim' };

  // The private link stopped working (expired, revoked or replaced): back to the
  // landing page with the "enter your email" box open.
  function linkGone(message) {
    clearTimeout(state.poll);
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    state.token = ''; state.view = null;
    try { history.replaceState(null, '', '/bloodmap'); } catch (_) {}
    $('dash').hidden = true; $('landing').hidden = false;
    closeModals();
    trackStepContact('');
    openModal('trackModal');
    showMsg($('tMsg'), message || '', 'info');
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function openOrder(opts) {
    opts = opts || {};
    if (!state.token) return;
    api('GET', orderUrl()).then(function (r) {
      if (r.status === 410) return linkGone('Your private link has expired. Enter your email and we will send you a code to get back in.');
      if (r.status === 404) return linkGone(opts.fallbackToTrack ? '' : 'That order link is not valid any more. Enter your email to find your order.');
      if (r.data.error) return;
      state.view = r.data;
      try { history.replaceState(null, '', '/bloodmap?o=' + encodeURIComponent(state.token)); } catch (_) {}
      try { localStorage.setItem(STORE_KEY, state.token); } catch (_) {}
      renderDash(opts.notice);
      window.scrollTo(0, 0);
    });
  }

  function refresh(silent) {
    return api('GET', orderUrl()).then(function (r) {
      if (r.status === 410 || r.status === 404) return linkGone('Your private link has expired. Enter your email and we will send you a code to get back in.');
      if (r.data.error) return;
      var before = state.view;
      state.view = r.data;
      // While the client is filling the upload form, a background refresh must not wipe it.
      if (silent && before && before.stage === r.data.stage && JSON.stringify(before.calls) === JSON.stringify(r.data.calls)) return;
      renderDash();
    });
  }

  function schedulePoll() {
    clearTimeout(state.poll);
    var v = state.view;
    if (!v) return;
    var waiting = v.stage === 'payment' || v.stage === 'analysing' || v.stage === 'review';
    state.poll = setTimeout(function () {
      if (document.hidden) return schedulePoll();
      refresh(true).then(schedulePoll);
    }, waiting ? 20000 : 90000);
  }

  function renderDash(notice) {
    var v = state.view;
    $('landing').hidden = true;
    $('dash').hidden = false;
    $('navBuy').hidden = true;
    $('navTrack').textContent = 'New order';
    $('navTrack').onclick = function () {
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      window.location.href = '/bloodmap';
    };
    $('footWa').href = waLink('Hi, I need help with my BloodMap order ' + v.ref + '.');

    $('dRef').textContent = v.ref;
    $('dHello').textContent = 'Hi ' + (String(v.client.name || '').split(/\s+/)[0] || 'there');
    var pill = $('dPill');
    pill.className = 'pill' + (STAGE_PILL[v.stage] ? ' pill--' + STAGE_PILL[v.stage] : '');
    pill.textContent = v.payment.status === 'refunded' ? 'Refunded' : (STAGE_LABEL[v.stage] || v.stage);

    $('dSteps').innerHTML = v.steps.map(function (s) {
      var when = s.at ? fmtWhen(s.at) : '';
      var note = s.state === 'current' && (s.key === 'doctor' || s.key === 'nutritionist') ? 'Booked · ' + when
        : s.state === 'current' ? (s.key === 'uploaded' ? 'Waiting for your file' : 'In progress') : (s.state === 'done' ? when : '');
      return '<li class="' + esc(s.state) + '"><b>' + esc(s.label) + '</b>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</li>';
    }).join('');

    $('dSteps').parentNode.hidden = v.stage === 'refunded';
    renderMain(notice);
    renderCalls();
    renderOffers();
    $('dHelp').innerHTML =
      '<h3 class="h3">Need help?</h3>' +
      '<p class="small" style="color:var(--creamd);margin:8px 0 14px">We emailed your private link to ' + esc(v.client.email) + '. It works for 30 days. After that, use Track my order with this email to get back in.</p>' +
      '<a class="btn btn--sm" target="_blank" rel="noopener" href="' + esc(waLink('Hi, I need help with my BloodMap order ' + v.ref + '.')) + '">Message us on WhatsApp</a>';
    schedulePoll();
  }

  function renderMain(notice) {
    var v = state.view;
    var el = $('dMain');
    var note = notice ? '<p class="msg msg--info">' + esc(notice) + '</p>' : '';

    if (v.stage === 'refunded') {
      el.innerHTML =
        '<h3 class="h3">This order was refunded</h3>' +
        '<p style="color:var(--creamd);margin:8px 0 16px">Your payment of ' + esc(v.payment.amount) + ' was refunded, so this order is closed. The report and the calls are no longer available on it.</p>' +
        '<a class="btn btn--gold" href="/bloodmap" id="mAgain">Start a new BloodMap</a>';
      $('mAgain').onclick = function () { try { localStorage.removeItem(STORE_KEY); } catch (_) {} };
      return;
    }

    if (v.stage === 'payment') {
      el.innerHTML = note +
        '<h3 class="h3">Complete your payment</h3>' +
        '<p style="color:var(--creamd);margin:8px 0 16px">Your details are saved. Pay ' + esc(v.payment.amount) + ' to start: Health Map report, doctor consultation and sports nutritionist consultation.</p>' +
        '<p class="msg" id="mMsg" hidden></p>' +
        '<button class="btn btn--gold" type="button" id="mPay">Pay ' + esc(v.payment.amount) + '</button>';
      $('mPay').onclick = function () {
        var btn = this;
        btn.disabled = true;
        api('POST', orderUrl('/pay')).then(function (r) {
          if (r.data.error) { btn.disabled = false; return showMsg($('mMsg'), r.data.error); }
          runCheckout(r.data, function (err, pending) {
            btn.disabled = false;
            if (err) return showMsg($('mMsg'), err);
            refresh().then(function () { if (pending) showMsg($('mMsg'), 'Your payment is still processing. This page will update on its own.', 'info'); });
          });
        });
      };
      return;
    }

    if (v.stage === 'upload') { renderUpload(note); return; }

    if (v.stage === 'analysing' || v.stage === 'review') {
      var review = v.stage === 'review';
      el.innerHTML = note +
        '<div class="pulse"><span class="ring" aria-hidden="true"></span><div>' +
        '<h3 class="h3">' + (review ? 'An expert is reviewing your report' : 'We are analysing your report') + '</h3>' +
        '<p style="color:var(--creamd);margin-top:4px">' + (review
          ? 'Every marker has been read and graded. Our team is checking the Health Map before it is released to you.'
          : 'We are reading every marker on your lab report and grading each health area.') + '</p></div></div>' +
        '<div class="bar"><i style="width:' + (review ? 78 : 42) + '%"></i></div>' +
        '<p class="small mute" style="margin-top:12px">' + (v.report.due_by ? 'Expected by ' + esc(v.report.due_by) + ' (India time). ' : '') +
        'We will email you the moment it is ready. You can close this page.</p>';
      return;
    }

    // ready / completed
    var pdf = orderUrl('/report.pdf');
    el.innerHTML = note +
      '<p class="eyebrow">Your Health Map report</p>' +
      '<h3 class="h2" style="margin:8px 0 8px">Your report is ready</h3>' +
      '<p style="color:var(--creamd);margin-bottom:18px">It has been analysed and reviewed. Read it before your doctor call and note down anything you want to ask.</p>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<a class="btn btn--gold" target="_blank" rel="noopener" href="' + esc(pdf) + '">View report</a>' +
      '<a class="btn" href="' + esc(pdf + '?dl=1') + '">Download PDF</a></div>';
  }

  /* upload */
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '').replace(/^data:[^,]*,/, '')); };
      fr.onerror = function () { reject(new Error('read')); };
      fr.readAsDataURL(file);
    });
  }

  function renderUpload(note) {
    var v = state.view;
    var el = $('dMain');
    state.files = [];
    var today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    el.innerHTML = note +
      (v.upload.reupload_note ? '<p class="msg msg--info"><b>We need a clearer copy.</b> ' + esc(v.upload.reupload_note) + '</p>' : '') +
      '<p class="eyebrow">Step 2 of 3</p>' +
      '<h3 class="h2" style="margin:8px 0 6px">Upload your blood report</h3>' +
      '<p style="color:var(--creamd);margin-bottom:18px">Payment received. Add the PDF from your lab, or up to ' + MAX_IMAGES + ' clear photos of the pages.</p>' +
      '<label class="drop" id="uDrop" for="uFile"><b>Choose a file or drop it here</b><span>PDF, JPG or PNG · up to 20 MB</span></label>' +
      '<input type="file" id="uFile" accept="application/pdf,image/jpeg,image/png" multiple hidden>' +
      '<ul class="files" id="uFiles"></ul>' +
      '<div class="field"><label for="uDate">Date of the blood test <span class="opt">(printed on the report)</span></label><input type="date" id="uDate" max="' + today + '"></div>' +
      '<div class="field"><label for="uGoal">Your main goal <span class="opt">(optional)</span></label><input id="uGoal" maxlength="200" placeholder="For example: lose fat, more energy, manage cholesterol"></div>' +
      '<div class="field"><label for="uMeds">Medicines or supplements you take <span class="opt">(optional)</span></label><textarea id="uMeds" maxlength="400" placeholder="Name and dose, if you know it"></textarea></div>' +
      '<div class="field"><label for="uCond">Known health conditions <span class="opt">(optional)</span></label><textarea id="uCond" maxlength="400" placeholder="For example: thyroid, diabetes, PCOS, high BP"></textarea></div>' +
      '<p class="msg" id="uMsg" hidden></p>' +
      '<button class="btn btn--gold btn--block" type="button" id="uSend">Upload and start analysis</button>' +
      '<p class="secure">Your report is only seen by our review team and the experts on your calls.</p>';

    var input = $('uFile'), drop = $('uDrop');
    function paintFiles() {
      $('uFiles').innerHTML = state.files.map(function (f, i) {
        return '<li><span>' + esc(f.name) + '</span><button type="button" data-i="' + i + '">Remove</button></li>';
      }).join('');
      Array.prototype.forEach.call($('uFiles').querySelectorAll('button'), function (b) {
        b.onclick = function () { state.files.splice(Number(b.getAttribute('data-i')), 1); paintFiles(); };
      });
    }
    function addFiles(list) {
      showMsg($('uMsg'), '');
      var next = state.files.concat(Array.prototype.slice.call(list));
      var bad = next.filter(function (f) { return !/^(application\/pdf|image\/jpeg|image\/png)$/.test(f.type); });
      if (bad.length) return showMsg($('uMsg'), 'Please upload a PDF, or JPG / PNG photos of the report.');
      var pdfs = next.filter(function (f) { return f.type === 'application/pdf'; });
      if (pdfs.length > 1 || (pdfs.length && next.length > 1)) return showMsg($('uMsg'), 'Upload one PDF, or up to ' + MAX_IMAGES + ' photos of the same report.');
      if (next.length > MAX_IMAGES) return showMsg($('uMsg'), 'Upload up to ' + MAX_IMAGES + ' photos. For a longer report, please upload the PDF.');
      if (next.reduce(function (n, f) { return n + f.size; }, 0) > MAX_TOTAL_BYTES) return showMsg($('uMsg'), 'These files are over 20 MB together. Please upload a smaller file.');
      state.files = next;
      paintFiles();
    }
    input.onchange = function () { addFiles(input.files); input.value = ''; };
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });

    $('uSend').onclick = function () {
      var btn = this;
      if (!state.files.length) return showMsg($('uMsg'), 'Please choose your blood report file.');
      btn.disabled = true; btn.textContent = 'Uploading and checking your report…';
      Promise.all(state.files.map(function (f) {
        return fileToBase64(f).then(function (b64) { return { base64: b64, mime: f.type }; });
      })).then(function (files) {
        return api('POST', orderUrl('/upload'), {
          files: files, reportDate: $('uDate').value, goal: $('uGoal').value, medicines: $('uMeds').value, conditions: $('uCond').value
        });
      }).then(function (r) {
        if (r.data.error) {
          btn.disabled = false; btn.textContent = 'Upload and start analysis';
          return showMsg($('uMsg'), r.data.error);
        }
        refresh().then(function () { window.scrollTo(0, 0); });
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Upload and start analysis';
        showMsg($('uMsg'), 'We could not read that file. Please try again.');
      });
    };
  }

  /* calls */
  function renderCalls() {
    var v = state.view;
    var el = $('dCalls');
    if (!v.calls.can_book) { el.hidden = true; return; }
    el.hidden = false;
    var doctorBooked = v.calls.doctor.status !== 'none';
    function row(role) {
      var c = v.consultants[role], b = v.calls[role];
      var action = '';
      if (b.status === 'done') action = '<span class="pill pill--ok">Completed</span>';
      else if (b.status === 'booked') {
        action = b.can_change
          ? '<button class="btn btn--sm" type="button" data-book="' + role + '">Change time</button>'
          : '<a class="btn btn--sm btn--ghost" target="_blank" rel="noopener" href="' + esc(waLink('Hi, I need to move my ' + c.label.toLowerCase() + ' call for BloodMap order ' + v.ref + '.')) + '">Ask to move</a>';
      } else if (role === 'nutritionist' && !doctorBooked) action = '<span class="pill pill--dim">After the doctor call</span>';
      else action = '<button class="btn btn--sm btn--gold" type="button" data-book="' + role + '">Choose a time</button>';
      var when = b.status === 'none' ? '' :
        '<p class="call-when">' + esc(fmtWhen(b.starts_at)) + ' IST</p>' +
        (b.status === 'booked' ? '<span>We will call you on ' + esc(v.client.phone) + '.' + (b.can_change ? ' ' + b.changes_left + ' change' + (b.changes_left === 1 ? '' : 's') + ' left.' : '') + '</span>' : '');
      return '<div class="call">' + avatar(c, true) +
        '<div class="call-main"><b>' + esc(c.label) + ' call</b>' + (c.published ? '<span>' + esc(c.name) + (c.title ? ' · ' + esc(c.title) : '') + '</span>' : '') + when + '</div>' + action + '</div>';
    }
    el.innerHTML =
      '<h3 class="h3">Your consultations</h3>' +
      '<p class="small" style="color:var(--creamd);margin:6px 0 18px">Doctor first, then your sports nutritionist. Each call is 30 minutes and can run up to an hour. You can change a time up to ' + v.calls.cutoff_hours + ' hours before it starts.</p>' +
      row('doctor') + row('nutritionist');
    Array.prototype.forEach.call(el.querySelectorAll('[data-book]'), function (b) {
      b.onclick = function () { openSlots(b.getAttribute('data-book')); };
    });
  }

  function openSlots(role) {
    var v = state.view;
    var c = v.consultants[role];
    $('slotTitle').textContent = c.label + ' call';
    $('slotSub').textContent = (c.published ? 'With ' + c.name + '. ' : '') + 'All times are India time (IST).';
    $('slotBody').innerHTML = '<p class="mute">Loading free times…</p>';
    openModal('slotModal');
    api('GET', orderUrl('/slots?role=' + encodeURIComponent(role))).then(function (r) {
      var d = r.data;
      if (d.error || d.needs) { $('slotBody').innerHTML = '<p class="msg msg--info">' + esc(d.error || d.message) + '</p>'; return; }
      if (!d.days || !d.days.length) {
        $('slotBody').innerHTML = '<p class="msg msg--info">There are no free times in the next two weeks. Message us on WhatsApp and we will arrange one for you.</p>';
        return;
      }
      var dayIdx = 0, picked = '';
      function paint() {
        var day = d.days[dayIdx];
        $('slotBody').innerHTML =
          '<div class="days">' + d.days.map(function (x, i) {
            var parts = x.label.split(', ');
            return '<button type="button" class="day' + (i === dayIdx ? ' on' : '') + '" data-d="' + i + '">' + esc(parts[0]) + '<b>' + esc((parts[1] || '').split(' ')[0]) + '</b>' + esc((parts[1] || '').split(' ')[1] || '') + '</button>';
          }).join('') + '</div>' +
          '<div class="slots">' + day.slots.map(function (s) {
            return '<button type="button" class="slot' + (s.start === picked ? ' on' : '') + (s.start === d.current ? ' cur' : '') + '" data-s="' + esc(s.start) + '">' + esc(s.label) + '</button>';
          }).join('') + '</div>' +
          '<p class="msg" id="sMsg" hidden></p>' +
          '<button class="btn btn--gold btn--block" type="button" id="sSave"' + (picked ? '' : ' disabled') + '>' + (d.current ? 'Move my call' : 'Confirm this time') + '</button>';
        Array.prototype.forEach.call($('slotBody').querySelectorAll('.day'), function (b) {
          b.onclick = function () { dayIdx = Number(b.getAttribute('data-d')); picked = ''; paint(); };
        });
        Array.prototype.forEach.call($('slotBody').querySelectorAll('.slot'), function (b) {
          b.onclick = function () { picked = b.getAttribute('data-s'); paint(); };
        });
        $('sSave').onclick = function () {
          var btn = this;
          btn.disabled = true;
          api('POST', orderUrl('/book'), { role: role, starts_at: picked }).then(function (res) {
            if (res.data.error) { btn.disabled = false; return showMsg($('sMsg'), res.data.error); }
            closeModals();
            refresh();
          });
        };
      }
      paint();
    });
  }

  /* offers */
  function renderOffers() {
    var v = state.view;
    var el = $('dOffers');
    if (!v.offers || !v.offers.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      '<p class="eyebrow">From BodyBank</p>' +
      '<h3 class="h3" style="margin:6px 0 16px">Turn this report into results</h3>' +
      '<div class="offers">' + v.offers.map(function (o) {
        return '<div class="offer"><span class="tag">' + esc(o.tag) + '</span><b>' + esc(o.title) + '</b><p>' + esc(o.body) + '</p>' +
          '<a class="btn btn--sm" target="_blank" rel="noopener" href="' + esc(waLink('Hi, I am a BloodMap client (' + v.ref + '). ' + o.cta + ': ' + o.title + '.')) + '">' + esc(o.cta) + '</a></div>';
      }).join('') + '</div>';
  }

  /* ───────────────────────── boot ───────────────────────── */

  function boot() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) { b.onclick = closeModals; });
    Array.prototype.forEach.call(document.querySelectorAll('.modal'), function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModals(); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModals(); });
    $('navTrack').onclick = openTrack;
    $('asideTrack').onclick = openTrack;
    bindOrderForm();

    var token = '';
    try { token = new URLSearchParams(window.location.search).get('o') || ''; } catch (_) {}
    if (token) { state.token = token; $('landing').hidden = true; }

    api('GET', '/api/bloodmap/config').then(function (r) {
      if (!r.data.error) { state.cfg = r.data; paintConfig(); }
      if (token) openOrder();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
