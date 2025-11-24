import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch"; // SMTP API calls

const app = express();
app.use(cors());
app.use(express.json());

// ========================================================
// FIREBASE INITIALIZATION
// ========================================================
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saRaw);
} catch (err) {
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
console.log("🔥 Firebase connected");

// ========================================================
// EMAIL SENDER FUNCTION (Brevo)
// ========================================================
async function sendEmail(to, subject, html) {
  try {
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
    console.log("📧 Email sent:", data);
    return data;
  } catch (err) {
    console.error("🔥 Email send error:", err);
  }
}

// ========================================================
// AUTO EMAIL TEMPLATES
// ========================================================
const EMAIL_TEMPLATES = {
  welcome: {
    subject: "🎉 Welcome to SAPP Academy!",
    html: `
      <h2>🎉 Welcome to SAPP Academy!</h2>
      <p>Thank you for joining our learning community.</p>
      <p>You will receive updates on new courses, promotions, and trading insights.</p>
      <p>Start your journey today!</p>
    `,
  },

  pending: {
    subject: "⏳ Payment Pending – Action Required",
    html: `
      <h2>⏳ Payment Pending</h2>
      <p>We received your order and are waiting for your payment.</p>
      <p>If you already paid, the blockchain is confirming it.</p>
      <p>We will notify you immediately once it is confirmed.</p>
    `,
  },

  confirming: {
    subject: "🔄 Payment Confirming",
    html: `
      <h2>🔄 Payment Confirming</h2>
      <p>Your payment is being confirmed on the blockchain.</p>
      <p>You will receive another email once your course unlocks.</p>
    `,
  },

  success: (plan) => ({
    subject: `🎉 Your ${plan} course is now unlocked!`,
    html: `
      <h2>🎉 Congratulations!</h2>
      <p>Your course <b>${plan}</b> has been successfully unlocked.</p>
      <p>You can now access your dashboard anytime:</p>
      <a href="https://sapp-academy.web.app">➡ Go to Dashboard</a>
    `,
  }),

  failed: {
    subject: "❌ Payment Failed",
    html: `
      <h2>❌ Payment Failed</h2>
      <p>Your payment could not be processed.</p>
      <p>Please try again or contact support.</p>
    `,
  },

  expired: {
    subject: "⚠️ Payment Expired",
    html: `
      <h2>⚠️ Payment Expired</h2>
      <p>Your payment window has expired.</p>
      <p>You can try again anytime from your dashboard.</p>
    `,
  },
};

// ========================================================
// SUBSCRIBE (Welcome email)
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

      // Send welcome email
      await sendEmail(
        lower,
        EMAIL_TEMPLATES.welcome.subject,
        EMAIL_TEMPLATES.welcome.html
      );
    }

    return res.status(200).send("saved");
  } catch (err) {
    console.error("🔥 Subscribe error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// NOWPAYMENTS WEBHOOK
// ========================================================
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

function safeNum(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}

app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Unauthorized webhook request");
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Webhook:", data);

    const paymentStatus = data.payment_status;
    const orderParts = (data.order_id || "").split("_");
    if (orderParts.length < 3 || orderParts[0] !== "sapp") {
      return res.status(400).send("Invalid order_id format");
    }

    const planSlug = orderParts[1];
    const userId = orderParts[2];
    const email = data.customer_email?.toLowerCase() || null;

    // STATUS: PENDING
    if (paymentStatus === "waiting") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.pending.subject,
          EMAIL_TEMPLATES.pending.html
        );
      return res.status(200).send("pending");
    }

    // STATUS: CONFIRMING
    if (paymentStatus === "confirming") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.confirming.subject,
          EMAIL_TEMPLATES.confirming.html
        );
      return res.status(200).send("confirming");
    }

    // STATUS: FAILED
    if (paymentStatus === "failed") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.failed.subject,
          EMAIL_TEMPLATES.failed.html
        );
      return res.status(200).send("failed");
    }

    // STATUS: EXPIRED
    if (paymentStatus === "expired") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.expired.subject,
          EMAIL_TEMPLATES.expired.html
        );
      return res.status(200).send("expired");
    }

    // STATUS: SUCCESS / FINISHED
    if (paymentStatus === "finished") {
      const amount = safeNum(data.price_amount);
      const currency = data.pay_currency || data.price_currency;
      const txnId =
        data.payment_id ||
        data.invoice_id ||
        data.order_id ||
        `np_${Date.now()}`;

      // Update Firestore
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

      // Log transaction
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

      // Send success email
      if (email) {
        const template = EMAIL_TEMPLATES.success(planSlug);
        await sendEmail(email, template.subject, template.html);
      }

      return res.status(200).send("ok");
    }

    return res.status(200).send("ignored");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// ADMIN BROADCAST
// ========================================================
app.post("/admin/broadcast", async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ error: "Subject & message required" });
    }

    const snapshot = await db.collection("subscribers").get();
    if (snapshot.empty) {
      return res.status(400).json({ error: "No subscribers found" });
    }

    const emails = snapshot.docs.map((d) => d.data().email);

    const payload = {
      sender: { name: "SAPP Admin", email: "sapp.academy2025@gmail.com" },
      to: emails.map((email) => ({ email })),
      subject,
      htmlContent: `<html><body>${message}</body></html>`,
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

    return res.json({
      success: true,
      sent_to: emails.length,
      brevo_response: data,
    });
  } catch (err) {
    console.error("🔥 Broadcast error:", err);
    return res.status(500).json({ error: "Broadcast failed" });
  }
});

// ========================================================
// START SERVER
// ========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 SAPP Webhook running on port ${PORT}`));
