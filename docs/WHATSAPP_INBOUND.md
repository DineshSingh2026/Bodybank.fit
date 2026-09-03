# Inbound WhatsApp mirroring (Phase 2 — draft / review)

BodyBank can receive a client WhatsApp message on the existing Twilio number, store it, draft a reply as Kling (xAI / Grok), and **hold it until a human approves**. Nothing is sent to the client automatically.

Outbound staff alerts (`utils/notify.js` → `services/whatsapp.js`) are unchanged.

## Kill switches

| Env | Default | Effect |
|-----|---------|--------|
| `WA_INBOUND_ENABLED` | `false` | `POST /wa/inbound` returns **503** and writes nothing |
| `WA_DRAFT_MODE` | `true` | Drafts are held for approval. Auto-send is **not implemented** even if you set this false |
| `XAI_API_KEY` | unset | Inbound is still stored; the draft becomes a handoff for Kling to write himself |
| `TWILIO_SID` / `TWILIO_AUTH` | existing | Same Twilio account as admin alerts |
| `ADMIN_WHATSAPP` / `ADMIN_WHATSAPP_LIST` | existing | Kling/staff get draft + handoff alerts |

## Twilio webhook

1. In Twilio Console → Messaging → WhatsApp sandbox (or your WhatsApp sender) → **When a message comes in**:
   - URL: `https://bodybank.fit/wa/inbound` (or your Render URL + `/wa/inbound`)
   - Method: `HTTP POST`
2. Optional exact-URL override if Twilio's signature does not match the public host:

   ```
   WA_INBOUND_WEBHOOK_URL=https://bodybank.fit/wa/inbound
   ```

3. The handler verifies `X-Twilio-Signature` with `TWILIO_AUTH`. Invalid signatures are **403**. Disabled inbound is **503**.

Twilio sends `application/x-www-form-urlencoded` (`From`, `Body`, `MessageSid`, …). The server does not return a client-facing TwiML reply.

## What happens on inbound

1. Message is stored in `wa_messages` (inbound).
2. Phone is matched to `users.phone` (digit-normalised, last 10). **No user is auto-created.**
3. Unmatched numbers are stored with `unmatched=true` and Kling is pinged to hand off.
4. Matched inbound builds context (`CLIENT_PROFILE`, last 10 activity events, last 30 WA messages, `TRIGGER=client_replied`) and calls xAI.
5. Grok must return JSON only:

   ```json
   {
     "message": "",
     "handoff": false,
     "handoff_reason": "",
     "send_at": null,
     "client_state_update": "",
     "internal_note": ""
   }
   ```

6. Code guards can force `handoff` (medical / blood report / refund / upset / injury / 3 unanswered agent messages / invented progress numbers / AI mention).
7. **Draft mode:** the reply is saved on `wa_drafts` and WhatsApp-notified to `ADMIN_WHATSAPP_LIST`. The client is not messaged.

## How Kling approves

**Admin UI** — Admin → Messages → **WhatsApp drafts**. Approve or reject. Approve may include an edited body.

**Reply on WhatsApp** (same Twilio number, from a number on `ADMIN_WHATSAPP` / `ADMIN_WHATSAPP_LIST`):

```
APPROVE abc12xyz
REJECT abc12xyz
```

(`YES` / `NO` + token also work.) The token is in the staff alert.

Handoff drafts are never sent to the client. Dismiss them after Kling has handled the thread himself.

## Quiet hours

Client-facing WhatsApp is blocked **21:30–08:00 IST**. Approving during that window (or a draft whose `send_at` falls in it) stores `send_at` at the next 08:00 IST. A 15-minute cron flushes approved, due drafts.

Staff draft/handoff alerts may still go out at night (same path as today's admin notify).

## Scheduler stub

A cron hook runs every 15 minutes (Asia/Kolkata). Besides flushing approved sends, it can fire trigger stubs. This PR implements **`no_activity_3d`** only: up to 3 quiet members, still through draft mode, skipped if a pending draft or a run in the last 3 days already exists. Future triggers (`missed_checkin`, `payment_due`, `weekly_followup`) should call the same `runTrigger` helper.

## Voice / STYLE_GUIDE

`services/waKlingPrompt.js` owns the system prompt. The `STYLE_GUIDE` block is marked **TODO-replace**.
