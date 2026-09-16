FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=development
ENV PORT=5173
ENV HOST=0.0.0.0

EXPOSE 5173

CMD ["npm", "run", "dev"]
