'use strict';

/**
 * FILE / IMAGE UPLOAD SECURITY SUITE
 *
 * Covers the public feed image path: authentication, poster identity, content-type
 * validation by magic bytes, size limits, and cross-user deletion.
 *
 *   node tests/security/test-file-upload.js
 */

const { assertIsolatedTestEnv, newTestSessionId } = require('./lib/env-guard');
const checkpoint = assertIsolatedTestEnv();

const { get, post, createUserFast } = require('./lib/client');
const A = require('./lib/assert');

const SESSION = newTestSessionId();

// Smallest valid images, as data URLs.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const asDataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

async function main() {
  console.log('\n=== SAFETY CHECKPOINT ===');
  Object.entries(checkpoint).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
  console.log(`  ${'testSessionId'.padEnd(24)} ${SESSION}`);
  console.log('=========================\n');

  const userA = await createUserFast('upl-a');
  const userB = await createUserFast('upl-b');
  const tA = { token: userA.token };
  const tB = { token: userB.token };

  // ---- 1. authentication ------------------------------------------------------
  console.log('--- 1. authentication ---');
  A.expectDenied(
    'anon -> POST /api/feed/upload',
    await post('/api/feed/upload', { imageData: asDataUrl(PNG_1x1, 'image/png') })
  );
  A.expectDenied(
    'anon -> POST /api/feed/delete',
    await post('/api/feed/delete', { postId: 'whatever', username: 'anyone' })
  );

  // ---- 2. content-type validation ---------------------------------------------
  console.log('\n--- 2. content-type validation (magic bytes, not extension) ---');

  const htmlPayload = Buffer.from('<html><script>alert(document.domain)</script></html>', 'utf8');
  A.expectStatus(
    'HTML disguised as image/png is rejected',
    await post('/api/feed/upload', { imageData: asDataUrl(htmlPayload, 'image/png') }, tA),
    400
  );

  const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'utf8');
  A.expectStatus(
    'SVG disguised as image/png is rejected',
    await post('/api/feed/upload', { imageData: asDataUrl(svgPayload, 'image/png') }, tA),
    400
  );

  const phpPayload = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');
  A.expectStatus(
    'PHP disguised as image/jpeg is rejected',
    await post('/api/feed/upload', { imageData: asDataUrl(phpPayload, 'image/jpeg') }, tA),
    400
  );

  A.expectStatus(
    'non-image data URL is rejected',
    await post('/api/feed/upload', { imageData: 'data:text/html;base64,PGgxPmhpPC9oMT4=' }, tA),
    400
  );

  // ---- 3. size limit ------------------------------------------------------------
  console.log('\n--- 3. size limit ---');
  const huge = 'data:image/png;base64,' + 'A'.repeat(13 * 1024 * 1024);
  const hugeRes = await post('/api/feed/upload', { imageData: huge }, tA);
  A.expectStatus('oversized base64 image is rejected', hugeRes, [400, 413]);

  // ---- 4. a genuine image is accepted (regression) --------------------------------
  console.log('\n--- 4. regression: a real image still uploads ---');
  const ok = await post(
    '/api/feed/upload',
    { imageData: asDataUrl(PNG_1x1, 'image/png'), caption: `${SESSION} test post`, username: 'IMPERSONATED', featured: '1' },
    tA
  );
  A.expectStatus('valid PNG uploads', ok, 201);
  const postId = ok.json?.post?.id;

  // ---- 5. poster identity cannot be spoofed ----------------------------------------
  console.log('\n--- 5. poster identity + editorial flag ---');
  if (ok.json?.post) {
    const uname = String(ok.json.post.username || '');
    uname.toUpperCase() === 'IMPERSONATED'
      ? A.fail('client-supplied username is ignored', `stored as ${uname}`)
      : A.pass('client-supplied username is ignored', `stored as ${uname}`);

    ok.json.post.featured === true
      ? A.fail('non-staff cannot set featured', 'featured was accepted from a member')
      : A.pass('non-staff cannot set featured');
  }

  // ---- 6. cross-user deletion -------------------------------------------------------
  console.log('\n--- 6. cross-user deletion ---');
  if (postId) {
    A.expectDenied(
      'USER_B cannot delete USER_A post',
      await post('/api/feed/delete', { postId, username: 'IMPERSONATED' }, tB)
    );
    A.expectDenied(
      'USER_B cannot delete by guessing the stored username',
      await post('/api/feed/delete', { postId, username: ok.json?.post?.username }, tB)
    );
    A.expectStatus(
      'USER_A can delete their own post',
      await post('/api/feed/delete', { postId }, tA),
      200
    );
  } else {
    A.warn('cross-user deletion', 'no post id returned; skipped');
  }

  A.summary('FILE UPLOAD RESULTS');
  process.exit(A.exitCode());
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exit(1);
});
