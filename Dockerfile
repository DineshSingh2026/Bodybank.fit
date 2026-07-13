# Debian slim (not alpine) so ReportLab installs from prebuilt manylinux wheels
# without a C toolchain. Node 20 + Python 3 for the branded health-report PDF.
FROM node:20-slim

WORKDIR /app

# Python 3 + pip for scripts/generate_health_report.py (ReportLab PDF renderer)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python deps (ReportLab). --break-system-packages: pip into the system env on
# Debian's externally-managed Python is intended here since the container is
# single-purpose.
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt

# Node deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --production

# App source — every dir the server actually loads at runtime.
COPY server.js ./
COPY routes/ ./routes/
COPY services/ ./services/
COPY scripts/ ./scripts/
COPY public/ ./public/

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
# Match render.yaml: use the real python3 and never ship the unbranded fallback.
ENV PYTHON_PATH=python3
ENV STRICT_TEMPLATE_PDF_ONLY=true

CMD ["node", "server.js"]
