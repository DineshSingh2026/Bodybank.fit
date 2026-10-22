# Tribe Elite sales brochure

Builds `docs/BodyBank-Tribe-Elite.pdf`: 9 pages, 4:5 (150 x 187.5 mm), for sharing with prospects on WhatsApp or email.

Needs the local server running on `localhost:3088` against the **local** database. The seed script refuses any non-local `DATABASE_URL`.

```sh
R="$(pwd)"                                                             # repo root
node scripts/brochure/seed-brochure-demo.js "$R"                       # fictional demo member "Arjun Mehta"
node scripts/brochure/capture.js "$R" care-group blood report          # app screenshots -> .work/shots
node scripts/brochure/build-sales.js "$R" "$R/docs/BodyBank-Tribe-Elite.pdf"
node scripts/brochure/render-pdf.js "$R" docs/BodyBank-Tribe-Elite.pdf scripts/brochure/.work/check   # check the real PDF with pdf.js
node scripts/brochure/seed-brochure-demo.js "$R" --clean               # remove the demo member
```

The build stops with exit code 2 if its layout audit fails:
- text outside the page or content area
- overlapping or clipped text
- a line budget (`data-max`) exceeded
- a large empty gap

Notes:
- **Copy lives in `build-sales.js`.** Member results come from `public/tribe-stories.html`: name, kg and weeks as published there.
- **Use opaque colours for gradients.** Chrome writes gradients with transparent stops in a way pdf.js renders magenta. A fade over a photo is baked into the image with sharp.
- **The QR code** comes from `assets/whatsapp-qr.png`. The `qrcode` package is used instead when it's installed.
