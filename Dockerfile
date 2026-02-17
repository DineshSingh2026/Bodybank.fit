FROM node:20-alpine

WORKDIR /app

# Copy package files and install
COPY package.json ./
RUN npm install --production

# Copy app files
COPY server.js ./
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "server.js"]
