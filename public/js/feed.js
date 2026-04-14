(function () {
  var feedList = document.getElementById('feedList');
  var feedSkeleton = document.getElementById('feedSkeleton');
  var feedEnd = document.getElementById('feedEnd');
  var trendRow = document.getElementById('trendRow');
  if (!feedList) return;

  var state = {
    offset: 0,
    limit: 6,
    loading: false,
    hasMore: true
  };
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) entry.target.classList.add('in-view');
    });
  }, { threshold: 0.2 });

  function likedMap() {
    try { return JSON.parse(localStorage.getItem('bb_feed_likes') || '{}'); } catch (_) { return {}; }
  }
  function saveLikedMap(map) { localStorage.setItem('bb_feed_likes', JSON.stringify(map)); }

  function renderSkeleton() {
    feedSkeleton.innerHTML = '';
    for (var i = 0; i < 2; i++) {
      var card = document.createElement('div');
      card.className = 'skeleton-card';
      card.innerHTML = '<div class="sk-top"></div><div class="sk-img"></div><div class="sk-bottom"></div>';
      feedSkeleton.appendChild(card);
    }
  }

  function relativeTime(iso) {
    var t = new Date(iso).getTime();
    if (!t) return 'now';
    var d = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (d < 60) return d + 's';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    return Math.floor(d / 86400) + 'd';
  }

  function cardTemplate(post) {
    var liked = !!likedMap()[post.id];
    var likesCount = Number(post.likes || 0) + (liked ? 1 : 0);
    var user = (post.username || 'bodybank').replace(/[^\w.]/g, '').toLowerCase() || 'bodybank';
    return [
      '<article class="feed-card" data-id="' + post.id + '" data-likes="' + Number(post.likes || 0) + '">',
      '  <div class="feed-card-top">',
      '    <img class="feed-avatar" src="/img/logo.png" alt="BodyBank logo" loading="lazy">',
      '    <div>',
      '      <p class="feed-user">' + user + '</p>',
      '      <p class="feed-time">' + relativeTime(post.createdAt) + '</p>',
      '    </div>',
      '  </div>',
      '  <div class="feed-image-wrap">',
      '    <img src="' + post.imageUrl + '" alt="BodyBank member post" loading="lazy">',
      '    <div class="like-burst">❤️</div>',
      '  </div>',
      '  <div class="feed-actions">',
      '    <button class="feed-action-btn js-like ' + (liked ? 'liked' : '') + '" type="button" aria-label="Like">❤</button>',
      '    <button class="feed-action-btn" type="button" aria-label="Comment">💬</button>',
      '    <button class="feed-action-btn js-share" type="button" aria-label="Share">📤</button>',
      '  </div>',
      '  <div class="feed-meta">',
      '    <p class="feed-likes">Liked by <span class="js-like-count">' + likesCount + '</span> users</p>',
      '    <p class="feed-caption"><strong>' + user + '</strong> ' + (post.caption || '') + '</p>',
      '    <p class="feed-comments">View comments</p>',
      '  </div>',
      '</article>'
    ].join('');
  }

  function renderTrending(posts) {
    if (!trendRow || !posts || !posts.length) return;
    trendRow.innerHTML = posts.slice(0, 6).map(function (p) {
      return '<div class="trend-item"><img src="' + p.imageUrl + '" alt="Trending transformation" loading="lazy"></div>';
    }).join('');
  }

  async function fetchPosts() {
    if (state.loading || !state.hasMore) return;
    state.loading = true;
    renderSkeleton();
    try {
      var resp = await fetch('/api/feed/posts?offset=' + state.offset + '&limit=' + state.limit);
      var data = await resp.json();
      var posts = Array.isArray(data.posts) ? data.posts : [];
      if (state.offset === 0) renderTrending(posts);
      posts.forEach(function (post) {
        feedList.insertAdjacentHTML('beforeend', cardTemplate(post));
        var card = feedList.lastElementChild;
        if (card) revealObserver.observe(card);
      });
      state.offset += posts.length;
      state.hasMore = !!data.hasMore;
      feedEnd.classList.toggle('hidden', state.hasMore);
    } catch (_) {
      if (!feedList.innerHTML.trim()) {
        feedList.innerHTML = '<p style="padding:16px;color:#aaa">Could not load posts. Try again.</p>';
      }
    } finally {
      state.loading = false;
      feedSkeleton.innerHTML = '';
    }
  }

  function onLike(card) {
    var map = likedMap();
    var id = card.getAttribute('data-id');
    var base = Number(card.getAttribute('data-likes') || 0);
    var countEl = card.querySelector('.js-like-count');
    var btn = card.querySelector('.js-like');
    var burst = card.querySelector('.like-burst');
    map[id] = !map[id];
    saveLikedMap(map);
    btn.classList.toggle('liked', map[id]);
    countEl.textContent = String(base + (map[id] ? 1 : 0));
    if (map[id]) {
      burst.classList.remove('show');
      burst.offsetHeight;
      burst.classList.add('show');
    }
  }

  var lastTap = 0;
  var startY = 0;
  document.addEventListener('click', function (e) {
    var likeBtn = e.target.closest('.js-like');
    if (likeBtn) onLike(likeBtn.closest('.feed-card'));
    var shareBtn = e.target.closest('.js-share');
    if (shareBtn) {
      var card = shareBtn.closest('.feed-card');
      var img = card && card.querySelector('img');
      if (!img) return;
      if (navigator.share) {
        navigator.share({ title: 'BodyBank Elite Feed', text: 'BodyBank.fit transformation', url: window.location.href }).catch(function () {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(img.src).catch(function () {});
      }
    }
  });

  document.addEventListener('touchend', function (e) {
    var wrap = e.target.closest('.feed-image-wrap');
    if (!wrap) return;
    var now = Date.now();
    if (now - lastTap < 320) {
      var card = wrap.closest('.feed-card');
      if (card && !card.querySelector('.js-like').classList.contains('liked')) onLike(card);
    }
    if (startY > 0 && e.changedTouches && e.changedTouches[0]) {
      var deltaY = e.changedTouches[0].clientY - startY;
      if (Math.abs(deltaY) > 65) {
        var current = wrap.closest('.feed-card');
        var target = deltaY < 0 ? current.nextElementSibling : current.previousElementSibling;
        if (target && target.classList.contains('feed-card')) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }
    startY = 0;
    lastTap = now;
  }, { passive: true });
  document.addEventListener('touchstart', function (e) {
    var wrap = e.target.closest('.feed-image-wrap');
    if (!wrap || !e.touches || !e.touches[0]) return;
    startY = e.touches[0].clientY;
  }, { passive: true });

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) fetchPosts();
    });
  }, { rootMargin: '500px 0px 500px 0px' });
  observer.observe(feedEnd);
  fetchPosts();
})();
