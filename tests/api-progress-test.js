/**
 * Quick API test: login, progress GET/POST, admin user-progress
 * Run: node tests/api-progress-test.js
 * Server must be running on port 3000.
 */
const http = require('http');

const BASE = 'http://localhost:3000';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('1. Admin login...');
  const loginRes = await request('POST', '/api/auth/login', { email: 'admin@bodybank.fit', password: 'admin123' });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.status, loginRes.data);
    process.exit(1);
  }
  const token = loginRes.data.token;
  const adminId = loginRes.data.id;
  console.log('   OK. Token present:', !!token, 'Admin id:', adminId);

  if (!token) {
    console.error('   BUG: Login response missing "token". Progress and admin progress APIs require JWT.');
  }

  console.log('2. GET /api/progress (as admin, same id)...');
  const getProgressRes = await request('GET', '/api/progress', null, token);
  console.log('   Status:', getProgressRes.status, getProgressRes.data.error ? 'Error: ' + getProgressRes.data.error : 'OK');
  if (getProgressRes.data.logs) console.log('   Logs count:', getProgressRes.data.logs.length);

  console.log('3. POST /api/progress (log one entry)...');
  const postBody = {
    weight: 75.5,
    body_fat: 18,
    calories_intake: 2200,
    protein_intake: 140,
    workout_completed: true,
    workout_type: 'Upper',
    strength_bench: 60,
    strength_squat: 80,
    strength_deadlift: 100,
    sleep_hours: 7.5,
    water_intake: 2.5
  };
  const postRes = await request('POST', '/api/progress', postBody, token);
  console.log('   Status:', postRes.status, postRes.data.error ? 'Error: ' + postRes.data.error : 'Success:', !!postRes.data.success);

  console.log('4. GET /api/admin/users...');
  const usersRes = await request('GET', '/api/admin/users', null, token);
  console.log('   Status:', usersRes.status, Array.isArray(usersRes.data) ? 'Users: ' + usersRes.data.length : (usersRes.data.error || usersRes.data));

  console.log('5. GET /api/admin/user-progress/:userId (admin id)...');
  const adminProgressRes = await request('GET', '/api/admin/user-progress/' + adminId, null, token);
  console.log('   Status:', adminProgressRes.status, adminProgressRes.data.error ? 'Error: ' + adminProgressRes.data.error : 'OK');
  if (adminProgressRes.data.currentWeight != null) console.log('   currentWeight:', adminProgressRes.data.currentWeight);

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});
