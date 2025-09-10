import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import cors from "cors";
import axios from "axios";
import { google } from "googleapis";

dotenv.config();
const app = express();

// Giữ lại rawBody để verify chữ ký
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(cors());

const PORT = process.env.PORT || 4000;

// ===== Google Sheets Auth =====
async function initSheets() {
  const CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}
const sheets = await initSheets();

// ===== Verify chữ ký Webhook V2 =====
function verifyCassoSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((seg) => {
      const [k, v] = seg.split("=");
      return [k?.trim(), v?.trim()];
    }).filter(([k, v]) => k && v)
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const signedPayload = `${t}.${rawBody}`;
  const hmac = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return hmac === v1;
}

// ===== Webhook Casso =====
app.post("/casso-webhook", async (req, res) => {
  try {
    const signature = req.get("X-Casso-Signature") || "";
    const ok = verifyCassoSignature(req.rawBody, signature, process.env.CASSO_SECRET);
    if (!ok) {
      console.warn("❌ Invalid Casso Signature");
      return res.json({ success: true });
    }

    const body = req.body;
    if (body.error !== 0 || !body.data) return res.json({ success: true });

    const tx = body.data;
    const desc = tx.description?.trim() || "";
    console.log("📩 Webhook transaction:", desc);

    // Bắt orderCode: MEOSTORE4889, MEOSTORE-4889, MEOSTORE 4889, hoặc chỉ "4889"
    const match = desc.match(/(?:MEOSTORE[-\s]?)*(\d+)/i);
    if (!match) {
      console.warn("⚠️ Không tìm thấy orderCode:", desc);
      return res.json({ success: true });
    }

    const orderCode = match[1]; // ví dụ "4889"
    const amount = Number(tx.amount) || 0;
    const txId = String(tx.id ?? "");

    // Cập nhật Google Sheet
    const get = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: `${process.env.SHEET_NAME}!A2:M`,
    });
    const values = get.data.values || [];
    const rowIndex = values.findIndex((r) => String(r[0]).trim() === orderCode);

    if (rowIndex !== -1) {
      const rowNumber = rowIndex + 2;
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SHEET_ID,
        range: `${process.env.SHEET_NAME}!K${rowNumber}:M${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [["Đã thanh toán", amount.toString(), txId]] },
      });

      console.log(`💰 Order ${orderCode} updated to PAID`);

      // Báo về main-backend để socket.io emit cho client
      try {
        await axios.post(`${process.env.MAIN_BACKEND_URL}/api/orders/update`, {
          orderCode,
          status: "Đã thanh toán",
          txId,
          amount,
          desc,
        });
      } catch (notifyErr) {
        console.error("⚠️ Không báo được về main-backend:", notifyErr.message);
      }
    } else {
      console.warn(`⚠️ Không tìm thấy đơn hàng ${orderCode} trong Sheet`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.json({ success: true }); // tránh retry spam
  }
});

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`🚀 Webhook backend listening on port ${PORT}`);
});
