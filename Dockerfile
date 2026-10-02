# Start with Node.js 24 on a small Debian base.
FROM node:24-bookworm-slim

WORKDIR /app

# Copy dependency manifests first so dependency installation can be cached.
COPY package.json package-lock.json ./

# Install exactly the locked production dependencies.
RUN npm ci --omit=dev

# Copy the application source.
COPY . .

# Verify the RSS worker without contacting external services.
RUN npm test

ENV NODE_ENV=production

# Run as the non-root user included in the Node image.
USER node

EXPOSE 3000

# Run Node directly so it receives Cloud Run's shutdown signal.
CMD ["node", "server.js"]
