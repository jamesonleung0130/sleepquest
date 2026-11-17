# 睡得好，做得好：三夜好眠挑戰

NUR401 Aspects of Health Promotion 小組專題 —— 睡眠健康教育卡牌遊戲（手機版 + 後台 + 聯機房間）。

## 這是甚麼

- `web/`：前端（遊戲、問卷、後台介面、聯機房間）
- `server/`：Node.js 伺服器（帳號系統、問卷資料、WebSocket 房間）
- `data/`：卡牌與問卷題目

## 本機執行

```
cd server
npm install
node server.js
```

開啟 http://127.0.0.1:8080/admin 建立主管理員。

## 雲端部署（Render）

- Root Directory：`server`
- Build Command：`npm install`
- Start Command：`npm start`
- 環境變數（選填，但建議）：
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`

沒有 Upstash 也能跑，只是重新部署後問卷資料會清空。

## 注意

- 這是教學用途的專案，不是生產級系統。
- 不收集姓名、電話、身分證等可識別資料。
- 內容為一般健康教育資訊，不構成醫療建議。
