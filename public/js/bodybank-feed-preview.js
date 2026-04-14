(function () {
  var row = document.getElementById('bbFeedPreviewRow');
  if (!row) return;

  // Keep homepage lightweight: show only top 3 posts.
  fetch('/api/feed/posts?offset=0&limit=3')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var posts = Array.isArray(data.posts) ? data.posts : [];
      if (!posts.length) {
        row.innerHTML = '<p style="color:#bfb9ab;padding:8px">No feed posts yet. Be the first to post.</p>';
        return;
      }
      row.innerHTML = posts.map(function (p) {
        var uname = String(p.username || 'bodybank').toLowerCase().replace(/[^\w.]/g, '') || 'bodybank';
        return '<article class="bb-feed-preview-card">' +
          '<img src="' + p.imageUrl + '" alt="BodyBank community post" loading="lazy">' +
          '<div class="bb-feed-preview-meta">@' + uname + '</div>' +
          '</article>';
      }).join('');
    })
    .catch(function () {
      row.innerHTML = '<p style="color:#bfb9ab;padding:8px">Unable to load feed preview.</p>';
    });
})();
