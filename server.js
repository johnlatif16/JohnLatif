import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// حل مشكلة __dirname مع ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// 👇 ده أهم تعديل (root route)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// (اختياري) روت لصفحة اللوجين
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

const FIREBASE_CONFIG = JSON.parse(process.env.FIREBASE_CONFIG);
initializeApp({ credential: cert(FIREBASE_CONFIG) });
const db = getFirestore();

// --- Authentication middleware ---
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ message: "No token" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ message: "Invalid token" });
    req.user = user;
    next();
  });
}

// --- API routes ---
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: "2h" });
    res.json({ token });
  } else {
    res.status(401).json({ message: "Invalid credentials" });
  }
});

// Track attempts
app.post("/api/track-attempt", async (req, res) => {
  try {
    const { phone, action } = req.body;
    
    await db.collection("attempts").add({
      phone,
      action,
      timestamp: new Date(),
      userAgent: req.get("User-Agent")
    });
    
    res.json({ message: "Attempt tracked successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get attempts
app.get("/api/attempts/:phone", async (req, res) => {
  try {
    const { phone } = req.params;

    const snapshot = await db.collection("attempts")
      .where("phone", "==", phone)
      .orderBy("timestamp", "desc")
      .get();

    const attempts = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
    }));

    res.json(attempts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Submit
app.post("/api/submit", async (req, res) => {
  try {
    const { name, phone, correct, wrong, score, userAnswers } = req.body;

    await db.collection("attempts").add({
      phone,
      action: "submit",
      timestamp: new Date()
    });

    const existingSnapshot = await db.collection("results")
      .where("phone", "==", phone)
      .get();

    if (!existingSnapshot.empty) {
      const results = existingSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      const latestResult = results.sort((a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
      )[0];

      if (!latestResult.allowedRetake) {
        return res.status(400).json({
          message: "لقد قمت بالفعل بإرسال الاختبار."
        });
      }

      await Promise.all(existingSnapshot.docs.map(doc => doc.ref.delete()));
    }

    await db.collection("results").add({
      name,
      phone,
      correct,
      wrong,
      score,
      userAnswers,
      timestamp: new Date(),
      allowedRetake: false
    });

    res.json({ message: "Submitted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get results
app.get("/api/results", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("results")
      .orderBy("timestamp", "desc")
      .get();

    const results = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
    }));

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Delete result
app.delete("/api/results/:id", verifyToken, async (req, res) => {
  try {
    await db.collection("results").doc(req.params.id).delete();
    res.json({ message: "Deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Allow retake
app.post("/api/results/:id/allow-retake", verifyToken, async (req, res) => {
  try {
    await db.collection("results").doc(req.params.id).update({
      allowedRetake: true,
      retakeAllowedAt: new Date()
    });
    res.json({ message: "Retake allowed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Disallow retake
app.post("/api/results/:id/disallow-retake", verifyToken, async (req, res) => {
  try {
    await db.collection("results").doc(req.params.id).update({
      allowedRetake: false,
      retakeDisallowedAt: new Date()
    });
    res.json({ message: "Retake disallowed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Check retake
app.get("/api/check-retake/:phone", async (req, res) => {
  try {
    const snapshot = await db.collection("results")
      .where("phone", "==", req.params.phone)
      .get();

    if (snapshot.empty) {
      return res.json({ allowedRetake: false });
    }

    const results = snapshot.docs.map(doc => ({
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || doc.data().timestamp
    }));

    const latest = results.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    )[0];

    res.json({ allowedRetake: latest.allowedRetake || false });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
