FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
