FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
ENV PORT=8788
EXPOSE 8788
CMD ["node", "server.js"]
