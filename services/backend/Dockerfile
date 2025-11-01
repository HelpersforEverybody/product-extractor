FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copy package manifests; the wildcard safely copies package-lock.json if present
COPY services/backend/package*.json ./

# Install deps as root. Use npm ci when the lockfile exists, otherwise fallback.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy the rest of the backend
COPY services/backend/ ./

# Ensure debug dir exists and is writable
RUN mkdir -p /app/public/debug && chown -R pwuser:pwuser /app/public

# Drop privileges after install
USER pwuser

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
