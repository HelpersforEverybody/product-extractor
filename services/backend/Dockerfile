# services/backend/Dockerfile

FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Copy only the backend package files (note the services/backend/ prefix)
COPY services/backend/package.json services/backend/package-lock.json* ./

# Install deps
RUN npm ci --omit=dev || npm install --production

# Copy the rest of the backend source
COPY services/backend/ ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
