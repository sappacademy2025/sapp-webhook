import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch"; // SMTP API calls

const app = express();
app.use(cors());
app.use(express.json());
// 🔥 Serve static files (logo, icons, etc.)
app.use(express.static("public"));

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
// BRAND TEMPLATE WRAPPER
// ========================================================
function SAPP_TEMPLATE({ title, messageHTML }) {
  return `
  <div style="background:#0d0f12;padding:30px;font-family:Arial,sans-serif;color:white;">
    <div style="max-width:600px;margin:auto;background:#14171c;padding:40px;border-radius:12px;">
      
      <!-- Logo -->
      <div style="text-align:center;">
        <img src="https://sapp-webhook-1.onrender.com/logo.png" width="80" style="margin-bottom:15px;">
      </div>

      <!-- Title -->
      <h2 style="text-align:center;color:#4ea1ff;">${title}</h2>

      <!-- Message -->
      <div style="margin-top:20px;line-height:1.8;font-size:15px;">
        ${messageHTML}
      </div>

      <!-- CTA Button -->
      <div style="text-align:center;margin-top:25px;">
        <a href="https://sapp-academy.web.app"
          style="background:#007bff;color:white;padding:12px 25px;border-radius:8px;text-decoration:none;font-weight:bold;">
          Go to Dashboard
        </a>
      </div>

      <!-- Footer -->
      <hr style="margin-top:30px;border-color:#333;">
      <div style="text-align:center;color:#888;font-size:12px;">
        SAPP Academy • All Rights Reserved <br>
        <div style="margin-top:10px;">
          <a href="https://wa.me/message/F6VR7MBP3TUCM1" style="color:#4ea1ff;text-decoration:none;margin-right:10px;">
            WhatsApp Support
          </a>
          |
          <a href="https://t.me/sappacademy" style="color:#4ea1ff;text-decoration:none;margin-left:10px;">
            Telegram
          </a>
        </div>
      </div>

    </div>
  </div>`;
}
// ========================================================
// AUTO EMAIL TEMPLATES (BRANDED)
// ========================================================
const EMAIL_TEMPLATES = {
  welcome: {
    subject: "🎉 Welcome to SAPP Academy!",
    html: SAPP_TEMPLATE({
      title: "Welcome to SAPP Academy!",
      messageHTML: `
        <p>Thank you for joining our learning community.</p>
        <p>You will receive updates on courses, promotions, and trading insights.</p>
        <p>Start your journey today!</p>
      `,
    }),
  },

  pending: {
    subject: "⏳ Payment Pending – Complete Your Payment",
    html: SAPP_TEMPLATE({
      title: "Payment Pending",
      messageHTML: `
        <p>Your order has been received. We are waiting for your payment.</p>
        <p>If you already paid, the blockchain is confirming it.</p>
        <p>You will receive updates automatically.</p>
      `,
    }),
  },

  confirming: {
    subject: "🔄 Payment Confirming",
    html: SAPP_TEMPLATE({
      title: "Payment Confirming",
      messageHTML: `
        <p>Your payment is being confirmed on the blockchain.</p>
        <p>You will receive another email once your course unlocks.</p>
      `,
    }),
  },

  failed: {
    subject: "❌ Payment Failed",
    html: SAPP_TEMPLATE({
      title: "Payment Failed",
      messageHTML: `
        <p>Your payment could not be processed.</p>
        <p>Please try again or contact support.</p>
      `,
    }),
  },

  expired: {
    subject: "⚠️ Payment Expired",
    html: SAPP_TEMPLATE({
      title: "Payment Expired",
      messageHTML: `
        <p>Your payment window expired.</p>
        <p>You can try again anytime from your dashboard.</p>
      `,
    }),
  },

  success: (plan) => ({
    subject: `🎉 ${plan} Course is Now Unlocked!`,
    html: SAPP_TEMPLATE({
      title: `Your ${plan} Course is Unlocked!`,
      messageHTML: `
        <p>Congratulations! Your course <b>${plan}</b> is now accessible.</p>
        <p>Log in anytime and continue learning.</p>
      `,
    }),
  }),
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
// NOWPAYMENTS WEBHOOK LOGIC (Statuses + Auto Emails + Affiliate Commission)
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
    const status = data.payment_status;
    console.log("💰 Webhook:", data);

    const orderParts = (data.order_id || "").split("_");
    if (orderParts.length < 3 || orderParts[0] !== "sapp") {
      return res.status(400).send("Invalid order_id format");
    }

    const planSlug = orderParts[1];
    const userId = orderParts[2];
    const referrerId = orderParts[3] || null; // NEW
    const email = data.customer_email?.toLowerCase() || null;

    // ====== PENDING ======
    if (status === "waiting") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.pending.subject,
          EMAIL_TEMPLATES.pending.html
        );
      return res.status(200).send("pending");
    }

    // ====== CONFIRMING ======
    if (status === "confirming") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.confirming.subject,
          EMAIL_TEMPLATES.confirming.html
        );
      return res.status(200).send("confirming");
    }

    // ====== FAILED ======
    if (status === "failed") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.failed.subject,
          EMAIL_TEMPLATES.failed.html
        );
      return res.status(200).send("failed");
    }

    // ====== EXPIRED ======
    if (status === "expired") {
      if (email)
        await sendEmail(
          email,
          EMAIL_TEMPLATES.expired.subject,
          EMAIL_TEMPLATES.expired.html
        );
      return res.status(200).send("expired");
    }

    // ====== FINISHED (SUCCESS) ======
    if (status === "finished") {
      const amount = safeNum(data.price_amount);
      const currency = data.pay_currency || data.price_currency;
      const txnId =
        data.payment_id ||
        data.invoice_id ||
        data.order_id ||
        `np_${Date.now()}`;

      // Save payment access
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

      // Save transaction record
      await db.collection("transactions").doc(String(txnId)).set(
        {
          userId,
          referrerId,
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

      // ===============================
      // AFFILIATE COMMISSION (20%)
      // ===============================
      if (referrerId) {
        const commission = Number((amount * 0.2).toFixed(2));

        await db.collection("affiliateEarnings").add({
          userId: referrerId,
          referredUserId: userId,
          email,
          plan: planSlug,
          amount,
          commission,
          commissionStatus: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          txnId,
        });

        console.log(`💰 Commission created: $${commission} for ${referrerId}`);
      }

      // Success email
      if (email) {
        const successTemplate = EMAIL_TEMPLATES.success(planSlug);
        await sendEmail(email, successTemplate.subject, successTemplate.html);
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
// START SERVER
// ========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 SAPP Webhook running on port ${PORT}`));
