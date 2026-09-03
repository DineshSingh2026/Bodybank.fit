/**
 * Inbound WhatsApp mirroring — Phase 2 guards.
 * Run: node tests/wa-inbound.js
 *
 * No network, no Postgres. The service is exercised with an in-memory store
 * and a stubbed xAI/Twilio send so we can prove the kill switches:
 *   invalid Twilio signature is rejected
 *   inbound is stored
 *   unmatched phones hand off (no user created, no client send)
 *   draft mode never calls client send
 *   quiet hours persist send_at for the next IST window
 *   medical / blood-report inbound sends nothing to the client
 */
'use strict';

const crypto = require('crypto');
const wa = require('../services/waInbound');
const prompt = require('../services/waKlingPrompt');

const failures = [];
let checks = 0;

function assert(ok, msg) {
  checks += 1;
  if (!ok) failures.push(msg);
  return ok;
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function check(cond, msg) {
  if (assert(cond, msg)) console.log('  OK   ' + msg);
  else console.log('  FAIL ' + msg);
}

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

function createMemoryStore(seedUsers) {
  const messages = [];
  const drafts = [];
  const triggerRuns = [];
  const users = (seedUsers || []).slice();

  return {
    messages,
    drafts,
    triggerRuns,
    users,
    async findMessageByTwilioSid(sid) {
      if (!sid) return null;
      return messages.find((m) => m.twilio_sid === sid) || null;
    },
    async insertMessage(row) {
      const rec = Object.assign({ unmatched: false, draft_id: null, ts: new Date().toISOString() }, row);
      messages.push(rec);
      return rec;
    },
    async listMessagesByPhone(phone, limit) {
      const key = last10(phone);
      return messages
        .filter((m) => last10(m.phone) === key)
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .slice(-(limit || 30));
    },
    async findUsersByPhone(phone) {
      const key = last10(phone);
      return users.filter((u) => last10(u.phone) === key);
    },
    async insertDraft(row) {
      const rec = Object.assign({ status: 'pending', created_at: new Date().toISOString() }, row);
      drafts.push(rec);
      return rec;
    },
    async getDraftById(id) {
      return drafts.find((d) => d.id === id) || null;
    },
    async getDraftByToken(token) {
      const t = String(token || '').toLowerCase();
      return drafts.find((d) => String(d.approve_token || '').toLowerCase() === t) || null;
    },
    async updateDraft(id, fields) {
      const rec = drafts.find((d) => d.id === id);
      if (!rec) return null;
      Object.assign(rec, fields);
      return rec;
    },
    async listDrafts(status) {
      return status ? drafts.filter((d) => d.status === status) : drafts.slice();
    },
    async listApprovedDue(now) {
      const t = new Date(now).getTime();
      return drafts.filter((d) => (
        d.status === 'approved' &&
        !d.handoff &&
        (!d.send_at || new Date(d.send_at).getTime() <= t)
      ));
    },
    async hasPendingDraft(clientId, trigger) {
      return drafts.some((d) => (
        d.client_id === clientId &&
        ['pending', 'approved'].includes(d.status) &&
        (!trigger || d.trigger === trigger)
      ));
    },
    async recentTriggerRun(trigger, clientId, since) {
      const sinceMs = new Date(since).getTime();
      return triggerRuns.find((r) => (
        r.trigger_name === trigger &&
        (r.client_id || null) === (clientId || null) &&
        new Date(r.ran_at || 0).getTime() >= sinceMs
      )) || null;
    },
    async insertTriggerRun(row) {
      const rec = Object.assign({ ran_at: new Date().toISOString() }, row);
      triggerRuns.push(rec);
      return rec;
    },
    async findNoActivityCandidates() { return []; },
    async listRecentActivity() { return []; },
    async unlinkClient() {}
  };
}

function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = function (c) { r.statusCode = c; return r; };
  r.json = function (b) { r.body = b; return r; };
  r.send = function (b) { r.body = b; return r; };
  r.type = function () { return r; };
  return r;
}

function signedReq(auth, url, params) {
  const signature = wa.twilioSignature(auth, url, params);
  return {
    body: params,
    headers: { 'x-twilio-signature': signature },
    get(name) {
      if (String(name).toLowerCase() === 'x-twilio-signature') return signature;
      if (String(name).toLowerCase() === 'host') return 'bodybank.fit';
      return '';
    },
    protocol: 'https'
  };
}

function makeSvc(overrides) {
  const store = overrides.store || createMemoryStore(overrides.users);
  const sent = [];
  const staff = [];
  const svc = wa.createWaInbound({
    store,
    uuidv4: () => crypto.randomUUID(),
    notify: async (event, payload) => {
      staff.push({ event, payload });
      return { ok: true };
    },
    sendWhatsApp: async (body, opts) => {
      sent.push({ body, to: opts && opts.to });
      return { ok: true, sid: 'SM-test' };
    },
    callAgent: overrides.callAgent || (async () => ({
      message: 'keep tomorrow easy and tell me how you feel after.',
      handoff: false,
      handoff_reason: '',
      send_at: null,
      client_state_update: '',
      internal_note: ''
    })),
    now: overrides.now || (() => new Date('2026-09-03T06:00:00.000Z')), // 11:30 IST
    config: Object.assign({
      inboundEnabled: true,
      draftMode: true,
      twilioAuth: 'test-auth-token',
      webhookUrl: 'https://bodybank.fit/wa/inbound',
      adminPhones: ['+919999999999'],
      xaiApiKey: 'test-key'
    }, overrides.config || {})
  });
  return { svc, store, sent, staff };
}

const AUTH = 'test-auth-token';
const URL = 'https://bodybank.fit/wa/inbound';
const CLIENT = {
  id: 'user-1',
  first_name: 'Ada',
  last_name: 'Member',
  email: 'ada@example.com',
  phone: '+919876543210',
  role: 'user',
  goal_type: 'fat_loss',
  subscription_status: 'active',
  plan_label: '12-week'
};

async function main() {
  section('Twilio signature rejection');
  {
    const { svc, store } = makeSvc({ users: [CLIENT] });
    const params = { From: 'whatsapp:+919876543210', Body: 'hey', MessageSid: 'SM1' };

    const bad = {
      body: params,
      headers: { 'x-twilio-signature': 'not-a-real-signature' },
      get(name) {
        if (String(name).toLowerCase() === 'x-twilio-signature') return 'not-a-real-signature';
        return '';
      }
    };
    const resBad = mockRes();
    await svc.handleWebhook(bad, resBad);
    check(resBad.statusCode === 403, 'invalid X-Twilio-Signature is 403');
    check(store.messages.length === 0, 'rejected signatures write nothing');

    const good = signedReq(AUTH, URL, params);
    check(wa.verifyTwilioSignature(good, { twilioAuth: AUTH, webhookUrl: URL }),
      'a correctly signed request verifies');

    const resOff = mockRes();
    const { svc: off, store: offStore } = makeSvc({ users: [CLIENT], config: { inboundEnabled: false } });
    await off.handleWebhook(good, resOff);
    check(resOff.statusCode === 503, 'WA_INBOUND_ENABLED=false returns 503 without needing a valid flow');
    check(resOff.body && resOff.body.error === 'disabled', '503 body says disabled');
    check(offStore.messages.length === 0, 'disabled webhook writes nothing');
  }

  section('inbound store + unmatched handoff');
  {
    const { svc, store, sent, staff } = makeSvc({ users: [CLIENT] });
    const result = await svc.processInbound({
      From: 'whatsapp:+919876543210',
      Body: 'ate dinner, feeling good',
      MessageSid: 'SM-in-1'
    });
    check(result.ok, 'matched inbound is accepted');
    check(store.messages.length === 1, 'inbound row is stored');
    check(store.messages[0].direction === 'inbound', 'stored direction is inbound');
    check(store.messages[0].client_id === 'user-1', 'matched to users.phone');
    check(store.messages[0].unmatched === false, 'matched row is not unmatched');
    check(store.drafts.length === 1, 'a draft is queued');
    check(sent.length === 0, 'draft mode does not call client send on inbound');
    check(staff.some((s) => s.event === 'WA_INBOUND_DRAFT'), 'Kling is notified of the draft');

    const { svc: uSvc, store: uStore, sent: uSent, staff: uStaff } = makeSvc({ users: [CLIENT] });
    const unmatched = await uSvc.processInbound({
      From: 'whatsapp:+911111111111',
      Body: 'hi from an unknown number',
      MessageSid: 'SM-unknown'
    });
    check(unmatched.kind === 'unmatched', 'unknown phone is unmatched');
    check(uStore.messages.length === 1, 'unmatched inbound is still stored');
    check(uStore.messages[0].unmatched === true, 'row is marked unmatched');
    check(uStore.messages[0].client_id == null, 'no user is auto-created or linked');
    check(uStore.users.length === 1, 'users table is unchanged');
    check(uStore.drafts.length === 0, 'no client draft is created for unmatched');
    check(uSent.length === 0, 'unmatched path sends nothing to the number');
    check(uStaff.some((s) => s.event === 'WA_UNMATCHED'), 'admin WhatsApp gets a handoff for the unknown number');
  }

  section('draft mode never sends to the client');
  {
    let agentCalls = 0;
    const { svc, sent, store } = makeSvc({
      users: [CLIENT],
      callAgent: async () => {
        agentCalls += 1;
        return {
          message: 'nice. same time tomorrow.',
          handoff: false,
          handoff_reason: '',
          send_at: null,
          client_state_update: '',
          internal_note: ''
        };
      }
    });

    const result = await svc.processInbound({
      From: 'whatsapp:+919876543210',
      Body: 'workout done',
      MessageSid: 'SM-draft'
    });
    check(result.clientSent === false, 'processInbound reports clientSent=false');
    check(sent.length === 0, 'sendWhatsApp was not called for the client');
    check(agentCalls === 1, 'the agent was asked for a draft');
    check(store.drafts[0].handoff === false, 'non-handoff draft is pending, not sent');
    check(store.drafts[0].status === 'pending', 'draft status is pending');

    const approved = await svc.approveDraft(store.drafts[0].id, { reviewedBy: 'kling' });
    check(approved.ok && approved.sent, 'explicit approve is what actually sends');
    check(sent.length === 1, 'client send happens only after approve');
    check(sent[0].to === '919876543210' || String(sent[0].to).includes('9876543210'),
      'approve sends to the client phone, not the admin list');
  }

  section('quiet-hours send_at');
  {
    const evening = () => new Date('2026-09-03T16:30:00.000Z'); // 22:00 IST
    check(wa.isQuietHours(evening()), '22:00 IST is inside quiet hours');
    check(!wa.isQuietHours(new Date('2026-09-03T06:00:00.000Z')), '11:30 IST is outside quiet hours');

    const next = wa.nextAllowedSendAt(evening());
    const istHour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false
    }).format(next);
    const istDay = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit'
    }).format(next);
    check(istHour === '08' || istHour === '8', 'next allowed window is 08:00 IST');
    check(istDay === '04' || istDay === '4', 'after 21:30 IST, send_at moves to the next calendar morning');

    const { svc, store, sent } = makeSvc({
      users: [CLIENT],
      now: evening
    });
    await svc.processInbound({
      From: 'whatsapp:+919876543210',
      Body: 'still up, quick question',
      MessageSid: 'SM-night'
    });
    const draft = store.drafts[0];
    check(!!draft.send_at, 'quiet-hours inbound persists send_at');
    check(new Date(draft.send_at).getTime() > evening().getTime(), 'send_at is after the current night');
    const approved = await svc.approveDraft(draft.id, { reviewedBy: 'kling' });
    check(approved.scheduled === true, 'approve during quiet hours schedules instead of sending');
    check(sent.length === 0, 'quiet-hours approve does not send to the client yet');
    check(store.drafts[0].status === 'approved', 'draft stays approved until the morning flush');
  }

  section('medical / handoff path sends nothing to the client');
  {
    const { svc, store, sent, staff } = makeSvc({
      users: [CLIENT],
      callAgent: async () => {
        throw new Error('agent must not be required for a medical inbound');
      }
    });

    const result = await svc.processInbound({
      From: 'whatsapp:+919876543210',
      Body: 'can you interpret my blood report from last week?',
      MessageSid: 'SM-blood'
    });
    check(result.kind === 'handoff', 'blood-report inbound is a handoff');
    check(sent.length === 0, 'handoff sends nothing to the client');
    check(store.drafts[0].handoff === true, 'draft is flagged handoff');
    check(!store.drafts[0].draft_body, 'handoff draft has no client-facing body');
    check(staff.some((s) => s.event === 'WA_INBOUND_HANDOFF'), 'Kling is notified with the reason');

    const approve = await svc.approveDraft(store.drafts[0].id);
    check(approve.ok === false && approve.reason === 'handoff_no_client_send',
      'approving a handoff still cannot message the client');
    check(sent.length === 0, 'client send count stays zero after a refused approve');

    check(wa.detectInboundHandoff('I think I have an injury on my knee').handoff,
      'injury language is a code-level handoff');
    check(wa.detectInboundHandoff('I want a refund').handoff,
      'refund language is a code-level handoff');
    check(wa.detectInboundHandoff('I am pregnant and not sure what to eat').handoff,
      'pregnancy language is a code-level handoff');
  }

  section('prompt + JSON parse + admin reply-to-approve');
  {
    check(prompt.STYLE_GUIDE.indexOf('TODO-replace') !== -1,
      'STYLE_GUIDE is marked TODO-replace');
    check(/never mention ai/i.test(prompt.STYLE_GUIDE),
      'placeholder STYLE_GUIDE forbids mentioning AI');
    check(/medical advice/i.test(prompt.buildSystemPrompt()),
      'system prompt forbids medical advice');
    check(/one idea/i.test(prompt.buildSystemPrompt()),
      'system prompt requires one idea per message');

    const parsed = wa.parseAgentJson('Here you go\n{"message":"see you at 7","handoff":false,"handoff_reason":"","send_at":null,"client_state_update":"","internal_note":"ok"}\n');
    check(parsed && parsed.message === 'see you at 7', 'agent output is parsed as JSON only');

    const cmd = wa.parseAdminCommand('APPROVE ab12cd34');
    check(cmd && cmd.action === 'approve' && cmd.token === 'ab12cd34',
      'Kling can approve by replying APPROVE <token>');
    check(wa.parseAdminCommand('REJECT zz99yy88').action === 'reject',
      'REJECT <token> is a reject');

    const { svc, store, sent } = makeSvc({ users: [CLIENT] });
    await svc.processInbound({
      From: 'whatsapp:+919876543210',
      Body: 'all good today',
      MessageSid: 'SM-appr'
    });
    const token = store.drafts[0].approve_token;
    const admin = await svc.processInbound({
      From: 'whatsapp:+919999999999',
      Body: 'APPROVE ' + token,
      MessageSid: 'SM-admin'
    });
    check(admin.kind === 'admin_command', 'admin WhatsApp reply is treated as a command');
    check(sent.length === 1, 'APPROVE from an admin number sends the held draft');
    check(store.messages.filter((m) => m.direction === 'inbound').length === 1,
      'the admin command is not stored as a client inbound');
  }

  section('guards: invented numbers, AI mention, 3 unanswered');
  {
    const invented = wa.applyGuards(
      { message: 'you are down 4.2 kg this week', handoff: false },
      { inboundBody: 'how am I doing?', contextText: 'goal_type fat_loss', consecutiveOutbound: 0 }
    );
    check(invented.handoff === true, 'invented progress kg not in context forces handoff');

    const ai = wa.applyGuards(
      { message: 'I am an AI coach so I drafted this', handoff: false },
      { inboundBody: 'hey', contextText: 'hey', consecutiveOutbound: 0 }
    );
    check(ai.handoff === true && ai.message === '', 'AI/bot mention is stripped and handed off');

    const piled = wa.applyGuards(
      { message: 'just checking in', handoff: false },
      { inboundBody: '', contextText: '', consecutiveOutbound: 3 }
    );
    check(piled.handoff === true, '3 agent messages with no client reply force handoff');
  }

  console.log('\n' + checks + ' checks, ' + failures.length + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
