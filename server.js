// server.js
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { google } from "googleapis";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ===== Google Sheets Auth =====
let sheets;
async function initSheets() {
  const CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}
(async () => {
  sheets = await initSheets();
  console.log("✅ Google Sheets ready");
})();

// ===== Verify chữ ký Webhook V2 =====
function verifyCassoSignature(rawBody, signatureHeader, secret) {
  if (process.env.NODE_ENV === "development") return true;
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map(seg => {
      const [k, v] = seg.split("=");
      return [k.trim(), v.trim()];
    })
  );

  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;

  const signedPayload = `${t}.${rawBody}`;
  const hmac = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  console.log("🔍 Verify Debug:", { t, v1, hmac });

  return hmac === v1;
}

// ===== Middleware chung =====
app.use(cors());
app.use(express.json()); // dùng cho API khác (create-order, order/:code)

// ===== API tạo đơn (ghi vào Google Sheet) =====
app.post("/create-order", async (req, res) => {
  try {
    const { uid, amount } = req.body;
    if (!uid || !amount) return res.status(400).json({ error: "Thiếu uid hoặc amount" });

    // Lấy mã đơn mới
    const codeRes = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME}!A2:A`,
    });
    const existingCodes = (codeRes.data.values || [])
      .map(r => parseInt(r[0], 10))
      .filter(n => !isNaN(n));
    const nextCode = (existingCodes.length ? Math.max(...existingCodes) : 0) + 1;

    const now = new Date();
    const isoTs = now.toISOString();
    const displayTs = now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    const orderRow = [
      nextCode,
      "GAME", uid, "", "", 1, displayTs, amount,
      "Chưa giao", "", "Chờ thanh toán", isoTs
    ];

    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
    const sheetInfo = meta.data.sheets.find(s => s.properties.title === process.env.SHEET_NAME);
    if (!sheetInfo) throw new Error("Sheet name not found");
    const sheetId = sheetInfo.properties.sheetId;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 } }
        }]
      }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME}!A2`,
      valueInputOption: "RAW",
      requestBody: { values: [orderRow] },
    });

    // Tạo QR
    const bankBin = process.env.RECEIVER_BANK_BIN;
    const accountNo = process.env.RECEIVER_ACCOUNT_NO;
    const accountName = process.env.RECEIVER_ACCOUNT_NAME;
    const orderCode = `MEOSTORE-${nextCode}`;
    const qrUrl = `https://img.vietqr.io/image/${bankBin}-${accountNo}-compact2.png?amount=${amount}&addInfo=${orderCode}&accountName=${encodeURIComponent(accountName)}`;

    res.json({ success: true, orderCode, amount, qrUrl });
  } catch (err) {
    console.error("❌ Create order error:", err.stack);
    res.status(500).json({ error: "Không thể tạo đơn" });
  }
});

// ===== Webhook V2 =====
app.post(
  "/casso-webhook",
  express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }),
  async (req, res) => {
    try {
      const signature = req.get("X-Casso-Signature") || "";
      const ok = verifyCassoSignature(req.rawBody, signature, process.env.CASSO_SECRET);

      if (!ok && process.env.NODE_ENV !== "development") {
        console.warn("❌ Invalid Casso Signature");
        return res.json({ success: true });
      }

      const body = req.body;
      if (body.error !== 0 || !body.data) return res.json({ success: true });

      const tx = body.data;
      const desc = tx.description || "";
      console.log("📩 Webhook transaction:", JSON.stringify(tx, null, 2));

      const match = desc.match(/MEOSTORE-?(\d+)/i);
      if (!match) {
        console.warn("⚠️ Không tìm thấy orderCode trong desc:", desc);
        return res.json({ success: true });
      }

      const orderCode = match[1];
      const amount = Number(tx.amount) || 0;
      const txId = String(tx.id ?? "");

      const get = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: `${process.env.SHEET_NAME}!A2:M`,
      });
      const values = get.data.values || [];
      const rowIndex = values.findIndex(r => String(r[0]).trim() === orderCode);

      if (rowIndex !== -1) {
        const rowNumber = rowIndex + 2;
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.SHEET_ID,
          range: `${process.env.SHEET_NAME}!K${rowNumber}:M${rowNumber}`,
          valueInputOption: "RAW",
          requestBody: { values: [["Đã thanh toán", amount.toString(), txId]] },
        });

        console.log(`💰 Order ${orderCode} updated to PAID`);

        io.emit("payment_success", {
          orderCode: `MEOSTORE-${orderCode}`,
          txId,
          amount,
          desc,
        });
      } else {
        console.warn(`⚠️ Không tìm thấy đơn hàng ${orderCode} trong Sheet`);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ Webhook error:", err.stack);
      res.json({ success: true });
    }
  }
);

// ===== Xem trạng thái đơn =====
app.get("/order/:orderCode", async (req, res) => {
  try {
    const code = req.params.orderCode.replace("MEOSTORE-", "");
    const get = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME}!A2:M`,
    });
    const values = get.data.values || [];
    const row = values.find(r => String(r[0]).trim() === code);
    if (!row) return res.status(404).json({ error: "Order not found" });

    res.json({ code: row[0], status: row[10], payment: row[9] });
  } catch (err) {
    console.error("❌ Get order error:", err.stack);
    res.status(500).json({ error: "Failed to get order" });
  }
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
