import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------
// Load Firebase service account from environment (Render)
// ------------------------------------------------------------------
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error(
    "❌ Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_CONFIG) environment variable"
  );
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saRaw);
} catch (err) {
  console.error("❌ Invalid JSON in FIREBASE_SERVICE_ACCOUNT:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase connected successfully!");

const db = admin.firestore();

// ------------------------------------------------------------------
// NOWPayments secret for simple signature check
// ------------------------------------------------------------------
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;
if (!NOWPAYMENTS_SECRET) {
  console.warn(
    "⚠️ NOWPAYMENTS_SECRET not set — signature verification will fail"
  );
}

// ------------------------------------------------------------------
// Helper: safely read numeric value
// ------------------------------------------------------------------
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------
// Webhook endpoint
// ------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  try {
    // 1) Basic signature check (simple equality – good enough for now)
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature:", signature);
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Payment received:", JSON.stringify(data));

    // 2) Only handle finished payments
    if (data.payment_status !== "finished") {
      console.log("ℹ️ Payment not finished, ignoring. Status:", data.payment_status);
      return res.status(200).send("ignored");
    }

    // ----------------------------------------------------------------
    // 3) Parse order_id
    //    We support both:
    //      - sapp_<productKey>_<userId>_<timestamp>
    //      - sapp_<course>_<userId>_<timestamp>
    //    productKey or course will be used as our "plan" / slug.
    // ----------------------------------------------------------------
    const orderId = data.order_id || "";
    const parts = orderId.split("_");

    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id format:", orderId);
      return res.status(400).send("Invalid order_id");
    }

    const productOrCourse = parts[1]; // e.g. beginner_free, advanced, etc.
    const userId = parts[2];

    if (!userId) {
      console.log("❌ Missing userId in order_id:", orderId);
      return res.status(400).send("Missing userId");
    }

    const planSlug = productOrCourse; // we’ll store under this key in payments

    // ----------------------------------------------------------------
    // 4) Extract payment info
    // ----------------------------------------------------------------
    const amount = toNumber(data.price_amount);
    const currency = data.pay_currency || data.price_currency || null;
    const customerEmail = data.customer_email || data.order_description || null;

    // Try to get a stable transaction id from NOWPayments
    const rawPaymentId =
      data.payment_id ||
      data.invoice_id ||
      data.order_id ||
      `np_${Date.now()}`;

    const txnId = String(rawPaymentId);

    // ----------------------------------------------------------------
    // 5) Write / merge into payments/{userId}
    // ----------------------------------------------------------------
    const paymentDocRef = db.collection("payments").doc(userId);

    const paymentUpdate = {
      [planSlug]: {
        status: "paid",
        amount: amount,
        currency: currency,
        gateway: "NOWPayments",
        orderId: orderId || null,
        txnId: txnId,
        email: customerEmail || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      },
    };

    await paymentDocRef.set(paymentUpdate, { merge: true });
    console.log(`✅ Updated payments for user '${userId}' plan '${planSlug}'`);

    // ----------------------------------------------------------------
    // 6) Create / update transactions/{txnId}
    // ----------------------------------------------------------------
    const txnRef = db.collection("transactions").doc(txnId);

    await txnRef.set(
      {
        userId,
        email: customerEmail || null,
        plan: planSlug,
        amount: amount,
        currency: currency,
        status: "paid",
        gateway: "NOWPayments",
        orderId,
        nowpaymentsPaymentId: data.payment_id || null,
        nowpaymentsInvoiceId: data.invoice_id || null,
        // raw data is optional; comment out if you want to save space
        raw: data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`🧾 Transaction '${txnId}' written to 'transactions' collection`);

    // ----------------------------------------------------------------
    // 7) Done
    // ----------------------------------------------------------------
    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    return res.status(500).send("server error");
  }
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Webhook running on port ${PORT}`);
});
