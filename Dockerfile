FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=80

COPY . .

EXPOSE 80

CMD ["node", "local-server.mjs"]
