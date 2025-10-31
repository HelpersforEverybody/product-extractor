# Playwright base image contains all Chromium deps
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# copy backend
COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
