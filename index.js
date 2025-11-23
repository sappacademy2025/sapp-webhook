import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch"; // Required for SMTP API call

const app = express();
app.use(cors());
app.use(express.json());

// ========================================================
// FIREBASE INITIALIZATION
// ========================================================
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT environment variable");
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

console.log("✅ Firebase connected!");
const db = admin.firestore();

// ========================================================
// SEND EMAIL (Brevo SMTP API)
// ========================================================
app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, html } = req.body;

    if (!to || !subject || !html) {
      return res.status(400).send("Missing email fields");
    }

    const payload = {
      sender: {
        name: "SAPP Academy",
        email: "sapp.academy2025@gmail.com",
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log("📧 Brevo Email Sent:", data);

    return res.status(200).json({ ok: true, brevo: data });
  } catch (error) {
    console.error("🔥 Email send error:", error);
    return res.status(500).send("Email error");
  }
});

// ========================================================
// NOWPAYMENTS WEBHOOK (Upgraded + Auto Email)
// ========================================================
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

function toNumber(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

app.post("/webhook", async (req, res) => {
  try {
    // Validate signature
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Unauthorized webhook request");
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Webhook Received:", data);

    // Ignore if not finished
    if (data.payment_status !== "finished") {
      return res.status(200).send("ignored");
    }

    // Parse order_id: sapp_<plan>_<user>
    const orderParts = (data.order_id || "").split("_");
    if (orderParts.length < 3 || orderParts[0] !== "sapp") {
      return res.status(400).send("Invalid order_id");
    }

    const planSlug = orderParts[1];
    const userId = orderParts[2];
    const email = data.customer_email || null;

    const amount = toNumber(data.price_amount);
    const currency = data.pay_currency || data.price_currency;

    const txnId =
      data.payment_id || data.invoice_id || data.order_id || `np_${Date.now()}`;

    // Save payment status
    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [planSlug]: {
            status: "paid",
            amount,
            currency,
            email,
            gateway: "NOWPayments",
            orderId: data.order_id,
            txnId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

    console.log("💾 Payment updated in Firestore");

    // Save transaction
    await db.collection("transactions").doc(String(txnId)).set(
      {
        userId,
        email,
        plan: planSlug,
        amount,
        currency,
        status: "paid",
        gateway: "NOWPayments",
        orderId: data.order_id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        raw: data,
      },
      { merge: true }
    );

    console.log("🧾 Transaction logged");

    // AUTO EMAIL: send unlock email
    if (email) {
      console.log("📨 Sending unlock email to:", email);

      await fetch("https://sapp-webhook-1.onrender.com/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: email,
          subject: `🎉 Your ${planSlug} course is now unlocked!`,
          html: `
            <h2>🎉 Congratulations!</h2>
            <p>Your course <b>${planSlug}</b> has been successfully unlocked.</p>
            <p>You can now log in anytime:</p>
            <a href="https://sapp-academy.web.app">➡ Go to Dashboard</a>
          `,
        }),
      });
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    return res.status(500).send("server error");
  }
});

// ========================================================
// BREVO EVENT WEBHOOK
// ========================================================
app.post("/brevo/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (!event.email) return res.status(200).send("ignored");

    await db.collection("emailEvents").add({
      email: event.email.toLowerCase(),
      event: event.event || "unknown",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      raw: event,
    });

    return res.status(200).send("stored");
  } catch (err) {
    console.error("🔥 Brevo webhook error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// SUBSCRIBE ROUTE
// ========================================================
app.post("/subscribe", async (req, res) => {
  try {
    const { email, uid = null, source = "manual" } = req.body;
    if (!email) return res.status(400).send("Missing email");

    const lower = email.toLowerCase();

    const q = await db
      .collection("subscribers")
      .where("email", "==", lower)
      .get();

    if (q.empty) {
      await db.collection("subscribers").add({
        email: lower,
        uid,
        status: "active",
        source,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const id = q.docs[0].id;
      await db.collection("subscribers").doc(id).update({
        uid,
        source,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).send("saved");
  } catch (err) {
    console.error("🔥 Subscribe error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// SERVER START
// ========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
