FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
COPY src ./src
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
