# services/backend/Dockerfile

FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# If your Dockerfile uses repo root context, keep the full paths:
COPY services/backend/package.json services/backend/package-lock.json* ./
RUN npm ci --omit=dev || npm install --production

COPY services/backend/ ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
