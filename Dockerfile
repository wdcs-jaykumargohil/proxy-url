FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY manager_server.js rpc_proxy.js ws_proxy.js ./
COPY public ./public

ENV NODE_ENV=production
ENV MANAGER_PORT=9090

EXPOSE 9090

CMD ["npm", "run", "start"]
