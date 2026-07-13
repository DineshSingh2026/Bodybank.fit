# Node-only image. The branded health-report PDF is pure Node (PDFKit) — no Python.
FROM node:20-slim

WORKDIR /app

# Node deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --production

# App source — every dir the server loads at runtime.
COPY server.js ./
COPY routes/ ./routes/
COPY services/ ./services/
COPY scripts/ ./scripts/
COPY public/ ./public/

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
