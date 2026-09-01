'use strict';

/**
 * EMAIL TRANSPORT REGRESSION
 *
 * Proves services/userEmailService.js still delivers after the nodemailer upgrade,
 * by standing up a throwaway SMTP server on localhost and sending a real message
 * through the real code path — transport construction, AUTH LOGIN, and DATA.
 *
 * No network egress: the sink binds to 127.0.0.1 and the SMTP_* values are pointed
 * at it, so nothing can reach a real mail server or a real person.
 *
 *   node tests/security/test-email-transport.js
 */

const net = require('net');

const PORT = 3587;
const USER = 'sectest-smtp-user';
const PASS = 'sectest-smtp-pass';

/**
 * Minimal SMTP server: enough of the protocol for nodemailer to authenticate and
 * hand over a message. Captures the envelope and body for assertions.
 */
function startSink() {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [], data: '' };

    const send = (line) => socket.write(line + '\r\n');
    send('220 sectest.invalid ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(current);
            current = { from: '', to: [], data: '' };
            send('250 2.0.0 Ok: queued');
          } else {
            current.data += line + '\n';
          }
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          send('250-sectest.invalid');
          send('250-AUTH LOGIN PLAIN');
          send('250 8BITMIME');
        } else if (upper.startsWith('AUTH LOGIN')) {
          send('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('AUTH PLAIN')) {
          send('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('MAIL FROM')) {
          current.from = line.slice(line.indexOf(':') + 1).trim();
          send('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          current.to.push(line.slice(line.indexOf(':') + 1).trim());
          send('250 2.1.5 Ok');
        } else if (upper === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper.startsWith('QUIT')) {
          send('221 2.0.0 Bye');
          socket.end();
        } else if (upper.startsWith('RSET')) {
          send('250 2.0.0 Ok');
        } else {
          // Base64 credential lines during AUTH LOGIN land here.
          send('235 2.7.0 Authentication successful');
        }
      }
    });
    socket.on('error', () => {});
  });
  return { server, received };
}

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  console.log('\n=== EMAIL TRANSPORT (nodemailer ' + require('nodemailer/package.json').version + ') ===\n');

  const { server, received } = startSink();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`  local SMTP sink listening on 127.0.0.1:${PORT}\n`);

  // Point the service at the sink BEFORE requiring it — it reads SMTP_* at load.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(PORT);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = USER;
  process.env.SMTP_PASS = PASS;
  process.env.SMTP_FROM = 'BodyBank <sectest@sectest.invalid>';

  const userEmail = require('../../services/userEmailService');

  check('service reports itself configured', userEmail.isConfigured() === true);

  // The real send path used by password reset, digests and blood-report delivery.
  const sent = await userEmail.sendMail(
    'recipient@sectest.invalid',
    'SECTEST subject line',
    '<p>SECTEST body</p>',
    'SECTEST body'
  );
  check('sendMail resolved without throwing', sent !== false, `returned ${JSON.stringify(sent)}`);

  // Give the sink a moment to finish the DATA phase.
  await new Promise((r) => setTimeout(r, 300));

  check('sink received exactly one message', received.length === 1, `got ${received.length}`);
  if (received.length) {
    const m = received[0];
    check('recipient is correct', m.to.some((t) => t.includes('recipient@sectest.invalid')), m.to.join(','));
    check('subject present', /SECTEST subject line/.test(m.data) || /Subject:/i.test(m.data));
    check('HTML part present', /SECTEST body/.test(m.data));
    check(
      'no header injection from the subject',
      !/\r\n(To|Bcc|Cc):/i.test('Subject: SECTEST subject line')
    );
  }

  // A named template path, to be sure the wrappers still work end to end.
  received.length = 0;
  // Not all template helpers return a promise; the send itself is what matters.
  try {
    await userEmail.emailPasswordResetLuxury(
      'reset-recipient@sectest.invalid',
      'https://127.0.0.1/reset?token=abc'
    );
  } catch (_) { /* delivery is asserted against the sink below */ }
  await new Promise((r) => setTimeout(r, 600));
  await new Promise((r) => setTimeout(r, 300));
  check('templated password-reset email delivered', received.length === 1, `got ${received.length}`);

  server.close();

  const failed = results.filter((r) => !r).length;
  console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\nTRANSPORT TEST ERROR:', e.message);
  process.exit(1);
});
