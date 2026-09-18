# Build the editor, then serve it from the PDF backend as one container.

# ---- stage 1: build the front end ----
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- stage 2: the server ----
FROM node:22-alpine AS server
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/index.js backend/md2pdf.js ./
COPY --from=web /app/dist ./public

EXPOSE 4000
USER node
CMD ["node", "index.js"]
