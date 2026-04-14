(function () {
  var session = null;
  try { session = JSON.parse(localStorage.getItem('bodybank_session') || 'null'); } catch (_) {}
  var loginWall = document.getElementById('loginWall');
  if (!session || (!session.token && !session.user && !session.email && !session.role)) {
    if (loginWall) loginWall.classList.remove('hidden');
  }

  var cameraPreview = document.getElementById('cameraPreview');
  var captureCanvas = document.getElementById('captureCanvas');
  var postPreview = document.getElementById('postPreview');
  var postStatus = document.getElementById('postStatus');
  var captionInput = document.getElementById('captionInput');
  var imageUploadInput = document.getElementById('imageUploadInput');
  var userPostsGrid = document.getElementById('userPostsGrid');
  var dashBackLink = document.getElementById('dashBackLink');
  var stream = null;
  var capturedDataUrl = '';

  // Keep users/admin inside app dashboard flow; avoid forcing login hash.
  if (dashBackLink) {
    if (session && (session.token || session.user || session.email || session.role)) {
      dashBackLink.href = '/index.html';
      dashBackLink.textContent = '← Back to dashboard';
    } else {
      dashBackLink.href = '/index.html#login';
      dashBackLink.textContent = '← Back to website';
    }
  }

  function setStatus(text, tone) {
    postStatus.textContent = text || '';
    postStatus.style.color = tone === 'error' ? '#ff8f88' : tone === 'ok' ? '#7be39f' : '#ababab';
  }

  function currentUsername() {
    var role = String(session?.role || session?.user?.role || '').toLowerCase();
    var base = String(session?.user?.username || session?.first_name || session?.email || 'bodybank_member');
    if (role === 'admin' || role === 'superadmin') {
      base = 'admin.' + base;
    }
    return String(base)
      .trim()
      .toLowerCase()
      .replace(/[^\w.]/g, '') || 'bodybank_member';
  }

  async function startCamera() {
    try {
      if (stream) return;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1350 } },
        audio: false
      });
      cameraPreview.srcObject = stream;
      setStatus('Camera ready.', 'ok');
    } catch (e) {
      setStatus('Camera access denied. Check browser permissions.', 'error');
    }
  }

  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function drawOverlay(ctx, w, h) {
    var stripH = Math.max(120, Math.round(h * 0.16));
    var y = h - stripH;
    var grad = ctx.createLinearGradient(0, y, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, w, stripH);
    ctx.fillStyle = '#fff';
    ctx.font = "700 " + Math.max(24, Math.round(stripH * 0.24)) + "px Inter, sans-serif";
    ctx.textBaseline = 'middle';
    var centerY = y + stripH * 0.62;
    var logoSize = Math.round(stripH * 0.54);
    var pad = Math.round(stripH * 0.22);
    var logo = new Image();
    logo.src = '/img/logo.png';
    return new Promise(function (resolve) {
      logo.onload = function () {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pad + logoSize / 2, centerY, logoSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(logo, pad, centerY - logoSize / 2, logoSize, logoSize);
        ctx.restore();
        ctx.fillText('bodybank', pad + logoSize + Math.round(stripH * 0.16), centerY);
        ctx.fillText('❤  💬', w - Math.round(stripH * 0.7), centerY);
        resolve();
      };
      logo.onerror = function () {
        ctx.fillText('BodyBank.fit', pad, centerY);
        ctx.fillText('❤  💬', w - Math.round(stripH * 0.7), centerY);
        resolve();
      };
    });
  }

  async function captureFrame() {
    if (!cameraPreview || !cameraPreview.videoWidth || !cameraPreview.videoHeight) {
      setStatus('Start camera first.', 'error');
      return;
    }
    var w = cameraPreview.videoWidth;
    var h = cameraPreview.videoHeight;
    captureCanvas.width = w;
    captureCanvas.height = h;
    var ctx = captureCanvas.getContext('2d');
    ctx.drawImage(cameraPreview, 0, 0, w, h);
    await drawOverlay(ctx, w, h);
    capturedDataUrl = captureCanvas.toDataURL('image/jpeg', 0.85);
    postPreview.src = capturedDataUrl;
    postPreview.classList.remove('hidden');
    setStatus('Captured. Add caption and post.', 'ok');
  }

  async function handleImageUpload(file) {
    if (!file) return;
    if (!/^image\//i.test(file.type || '')) {
      setStatus('Please select an image file.', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus('Image should be 8 MB or smaller.', 'error');
      return;
    }
    setStatus('Processing image…', 'default');
    try {
      var dataUrl = await new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(new Error('read_failed')); };
        fr.readAsDataURL(file);
      });
      var img = await new Promise(function (resolve, reject) {
        var i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = function () { reject(new Error('invalid_image')); };
        i.src = dataUrl;
      });
      captureCanvas.width = img.naturalWidth || img.width || 1080;
      captureCanvas.height = img.naturalHeight || img.height || 1350;
      var ctx = captureCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, captureCanvas.width, captureCanvas.height);
      await drawOverlay(ctx, captureCanvas.width, captureCanvas.height);
      capturedDataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);
      postPreview.src = capturedDataUrl;
      postPreview.classList.remove('hidden');
      setStatus('Image ready. Add caption and post.', 'ok');
    } catch (_) {
      setStatus('Could not process this image. Try another file.', 'error');
    } finally {
      if (imageUploadInput) imageUploadInput.value = '';
    }
  }

  async function uploadPost() {
    if (!capturedDataUrl) {
      setStatus('Capture or upload a photo first.', 'error');
      return;
    }
    var caption = String(captionInput.value || '').trim();
    if (!caption) {
      setStatus('Please add a caption before posting.', 'error');
      return;
    }
    setStatus('Posting...', 'default');
    try {
      var resp = await fetch('/api/feed/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageData: capturedDataUrl,
          caption: caption,
          username: currentUsername()
        })
      });
      var data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      setStatus('Post published successfully.', 'ok');
      captionInput.value = '';
      await loadUserPosts();
    } catch (e) {
      setStatus(e.message || 'Upload failed.', 'error');
    }
  }

  async function loadUserPosts() {
    userPostsGrid.innerHTML = '';
    try {
      var resp = await fetch('/api/feed/user-posts?username=' + encodeURIComponent(currentUsername()));
      var data = await resp.json();
      var posts = Array.isArray(data.posts) ? data.posts : [];
      if (!posts.length) {
        userPostsGrid.innerHTML = '<p style="grid-column:1/-1;color:#ababab;margin:4px 0 0">No posts yet. Create your first post from above.</p>';
        return;
      }
      userPostsGrid.innerHTML = posts.slice(0, 18).map(function (p) {
        return '<div class="user-tile"><img src="' + p.imageUrl + '" alt="Your post" loading="lazy"></div>';
      }).join('');
    } catch (_) {
      userPostsGrid.innerHTML = '<p style="grid-column:1/-1;color:#ababab;margin:4px 0 0">Unable to load your posts.</p>';
    }
  }

  document.getElementById('startCameraBtn').addEventListener('click', startCamera);
  document.getElementById('captureBtn').addEventListener('click', captureFrame);
  document.getElementById('uploadImageBtn').addEventListener('click', function () {
    if (imageUploadInput) imageUploadInput.click();
  });
  if (imageUploadInput) {
    imageUploadInput.addEventListener('change', function () {
      var file = imageUploadInput.files && imageUploadInput.files[0];
      if (file) handleImageUpload(file);
    });
  }
  document.getElementById('retakeBtn').addEventListener('click', function () {
    capturedDataUrl = '';
    postPreview.classList.add('hidden');
    setStatus('Ready for a new photo.', 'default');
  });
  document.getElementById('postBtn').addEventListener('click', uploadPost);
  document.getElementById('refreshPostsBtn').addEventListener('click', loadUserPosts);
  document.getElementById('captureFab').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    startCamera();
  });
  document.getElementById('captureNowTop').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    startCamera();
  });

  window.addEventListener('beforeunload', stopCamera);
  loadUserPosts();
})();
