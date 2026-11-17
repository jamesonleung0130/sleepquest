# 睡得好，做得好 — 雲端部署用
# docker build -t sleepquest . && docker run -p 8080:8080 sleepquest
FROM node:20-alpine

WORKDIR /app

# 只裝伺服器需要的依賴
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

WORKDIR /app/server

# 複製程式與前端
COPY server/ ./
COPY web/ /app/web/
COPY data/ /app/data/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
