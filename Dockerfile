FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backend ./backend
COPY database ./database
COPY frontend ./frontend
RUN mkdir -p storage
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "backend/src/server.js"]
