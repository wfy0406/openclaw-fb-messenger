# openclaw-fb-messenger（增強版 fork）

Facebook Messenger channel plugin for OpenClaw / Kimi Claw。
基於 [tuanminhhole/openclaw-fb-messenger](https://github.com/tuanminhhole/openclaw-fb-messenger) 0.1.1 增強，**專為 openclaw 2026.7.1（Kimi Claw 托管版）驗證**。

## 比原版多咗咩

| 功能 | 原版 0.1.1 | 呢個 fork 0.2.0 |
|---|---|---|
| 讀客人 FB 名 | ✅ | ✅（加 24h cache） |
| 客人 send 圖片 | ❌ 靜音丟棄 | ✅ AI 真係睇到（vision） |
| 客人 send 語音 | ❌ 靜音丟棄 | ✅ 自動轉寫做文字（廣東話優先） |
| 客人 send 影片/檔案/位置/連結 | ❌ 靜音丟棄 | ✅ 影片檔案 AI 收到；位置/連結有文字標註 |
| Sticker | ❌ | ✅ 當圖片處理 |
| 問題分流去 WhatsApp 群組 | ❌ | ✅ 三種模式（agent 判斷 / 每張相自動轉 / 全部轉） |
| AI send 圖俾客人 | 只支援 URL | ✅ URL + 本地檔（自動 multipart 上傳） |

## 安裝（Kimi Claw 終端）

```bash
openclaw plugins install git:github.com/wfy0406/openclaw-fb-messenger --force
openclaw gateway restart
```

## 設定（openclaw.json 節錄）

```jsonc
{
  "channels": {
    "fb-messenger": {
      "enabled": true,
      "pageId": "你的 Page ID",
      "pageAccessToken": "Page/User token（插件會自動換成永久 Page token）",
      "appId": "Meta App ID",
      "appSecret": "Meta App Secret",
      "verifyToken": "你自訂嘅 webhook verify token",
      "dmPolicy": "open",

      // === 以下係新增（全部有預設，可以唔填）===
      "mediaEnabled": true,                 // 收圖/片/檔
      "audioTranscriptionEnabled": true,    // 語音轉文字
      "audioLanguage": "yue",               // 廣東話
      "audioTranscriptionDailyCap": 200,    // 每日轉寫上限

      // 問題分流去 WhatsApp 群組
      "escalateChannel": "whatsapp",
      "escalateTo": "群組 JID，例如 12036xxxxxx@g.us",
      "escalateMode": "agent"               // off | agent | media | all
    }
  }
}
```

### escalateMode 點揀

- `agent`（建議）：AI 自己判斷客人係咪反映問題，係先將相關相片**逐張**轉發去群組，附 caption 註明客人名 + 原文。
- `media`：客人每張圖/片/檔案都**即刻逐張**轉發，唔經 AI 判斷。
- `all`：每條訊息都轉發。
- `off`：關閉（預設）。

### 點樣搵 WhatsApp 群組 JID

1. 確保你嘅 OpenClaw WhatsApp 插件已 login 兼加入咗嗰個群組。
2. 喺群組入面隨便 send 一句嘢。
3. 睇 gateway log 或該 session 嘅 `from`/`conversation id`，格式係 `一串數字@g.us` —— 嗰串就係 `escalateTo` 要填嘅值。

## 環境變數（替代 openclaw.json，secrets 首選）

`FB_MESSENGER_PAGE_ACCESS_TOKEN` / `FB_MESSENGER_APP_ID` / `FB_MESSENGER_APP_SECRET` / `FB_MESSENGER_VERIFY_TOKEN` / `FB_MESSENGER_ESCALATE_TO` / `FB_MESSENGER_ESCALATE_CHANNEL` / `FB_MESSENGER_ESCALATE_MODE` / `FB_MESSENGER_ESCALATE_ACCOUNT_ID` / `FB_MESSENGER_AUDIO_LANGUAGE`

## 驗證狀態

- `tsc --noEmit`：0 error（strict）
- `tsup` build + `node --check`：通過
- Mock webhook smoke test：18/18 斷言通過（文字/圖/語音/轉寫失敗/多圖逐張轉發/下載失敗 fallback/出圖 URL+本地檔/echo 過濾/sticker dedupe）

## Credit

Original plugin by [tuanminhhole](https://github.com/tuanminhhole/openclaw-fb-messenger). Enhanced fork maintained for Red Code HK.
