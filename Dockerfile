FROM node:20-alpine
# 安装时区数据，确保 TZ=Asia/Shanghai 生效
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai
WORKDIR /app
COPY package.json ./
COPY server.js ./
ENV PORT=8788
EXPOSE 8788
CMD ["node", "server.js"]
