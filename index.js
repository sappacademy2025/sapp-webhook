import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ✅ Your NOWPayments webhook secret (you’ll add it in Render)
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

// ✅ Main webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    if (signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature!");
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Payment received:", data);

    if (data.payment_status !== "finished") {
      console.log("Payment not finished yet.");
      return res.status(200).send("Pending ignored");
    }

    // Extract course and user ID from your order_id format (e.g., sapp_beginner_uid_timestamp)
    const [prefix, course, userId] = data.order_id.split("_");
    if (!userId || !course)
      return res.status(400).send("Invalid order_id format");

    // ✅ Unlock course for that user
    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [course]: {
            status: "paid",
            currency: data.pay_currency,
            amount: data.price_amount,
            timestamp: new Date().toISOString(),
          },
        },
        { merge: true }
      );

    console.log(`✅ Course ${course} unlocked for user ${userId}`);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    res.status(500).send("Server error");
  }
});

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
