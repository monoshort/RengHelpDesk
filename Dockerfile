# Optioneel: Render / Railway / Fly.io kunnen ook vanuit deze image bouwen.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY static ./static
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]
