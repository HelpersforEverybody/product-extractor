FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# 1) Copy only the package metadata first (for better layer caching).
# If you don't have a package-lock.json in repo, this COPY will still succeed,
# but the file won't exist in the image.
COPY services/backend/package.json ./ 
COPY services/backend/package-lock.json ./  # keep this line; if absent it’s fine

# 2) Install deps as root. Use npm ci if lockfile exists, otherwise fallback to npm install.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# 3) Copy the rest of the backend source.
COPY services/backend/ ./

# 4) Ensure the debug folder exists and is writable.
RUN mkdir -p /app/public/debug && chown -R pwuser:pwuser /app/public

# 5) Drop privileges only AFTER dependencies are installed.
USER pwuser

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
