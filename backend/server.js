require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const { initializeApp, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

let firebaseCredential;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    firebaseCredential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
} else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    firebaseCredential = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    });
} else {
    firebaseCredential = applicationDefault();
}

initializeApp({ credential: firebaseCredential });

const db = getFirestore();
const auth = getAuth();
const app = express();
app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_ORIGINS || "https://fitcampus-c6dd1.web.app,http://localhost:5500,http://127.0.0.1:5500")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));
app.use(express.json());

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const firebaseWebApiKey = process.env.FIREBASE_WEB_API_KEY;
const isProduction = process.env.NODE_ENV === "production";

const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        message: "Too many login attempts. Please try again later."
    }
});
const loginAccountRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyGenerator: (req) => String(req.body?.email || "").trim().toLowerCase(),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        message: "Too many login attempts for this account. Please try again later."
    }
});

app.get("/", (req, res) => {
    res.json({
        message: "FitCampus Backend is running"
    });
});

app.post("/ai/classify", async (req, res) => {
    const { system, messages } = req.body;

    if (!anthropicApiKey) {
        return res.status(503).json({
            message: "AI assistant is not configured."
        });
    }

    if (typeof system !== "string" || !Array.isArray(messages) || messages.length === 0 ||
        messages.length > 20 || messages.some((message) =>
            !message || !["user", "assistant"].includes(message.role) ||
            typeof message.content !== "string" || message.content.length > 4000)) {
        return res.status(400).json({
            message: "Invalid AI request."
        });
    }

    try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": anthropicApiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: anthropicModel,
                max_tokens: 300,
                system,
                messages
            })
        });

        if (!response.ok) {
            console.error("Anthropic API request failed with status", response.status);
            return res.status(502).json({
                message: "AI assistant is temporarily unavailable."
            });
        }

        return res.json(await response.json());
    } catch (error) {
        console.error("Anthropic API request failed:", error);
        return res.status(502).json({
            message: "AI assistant is temporarily unavailable."
        });
    }
});

// Validates that the email belongs to Gmail, Yahoo, or Microsoft domains
function isAllowedEmailDomain(email) {
    if (!email || typeof email !== "string") return false;
    const cleanEmail = email.trim().toLowerCase();
    
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) return false;

    const domain = cleanEmail.split("@")[1];
    if (!domain) return false;

    // Gmail / Google
    const isGoogle = domain === "gmail.com" || domain === "googlemail.com";
    
    // Yahoo
    const isYahoo = domain === "yahoo.com" || domain === "ymail.com" || /^yahoo\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain);
    
    // Microsoft (Outlook, Hotmail, Live, MSN, Microsoft)
    const isMicrosoft = domain === "outlook.com" || 
                        domain === "hotmail.com" || 
                        domain === "live.com" || 
                        domain === "msn.com" || 
                        domain === "microsoft.com" ||
                        /^outlook\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain) ||
                        /^hotmail\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain);

    return isGoogle || isYahoo || isMicrosoft;
}

app.post("/signup", async (req, res) => {
    try {
        const { email, password, name, phone, age, gender, accessibility } = req.body;

        if (!email || !isAllowedEmailDomain(email)) {
            return res.status(400).json({
                message: "Access restricted: Only valid Gmail (@gmail.com), Yahoo (@yahoo.com), or Microsoft (@outlook.com, @hotmail.com, @live.com) emails are permitted."
            });
        }

        const user = await auth.createUser({
            email: email.trim().toLowerCase(),
            password: password,
            displayName: name
        });

        await db.collection("users").doc(user.uid).set({
            name: name,
            email: email.trim().toLowerCase(),
            phone: phone || null,
            age: age || null,
            gender: gender || null,
            accessibility: accessibility || "Standard Mode",
            createdAt: new Date()
        });

        res.json({
            message: "Signup successful",
            uid: user.uid
        });

    } catch (error) {
        console.error(error);

        if (error.code === "auth/email-already-exists") {
            return res.status(409).json({
                message: "An account with this email already exists."
            });
        }

        if (error.code === "auth/invalid-password" || error.code === "auth/invalid-email" ||
            error.message?.includes("PASSWORD_DOES_NOT_MEET_REQUIREMENTS")) {
            return res.status(400).json({
                message: "Password must be at least 6 characters and include a special character, such as @ or !."
            });
        }

        res.status(500).json({
            message: "Unable to create account. Please try again later."
        });
    }
});

app.post("/login", loginRateLimit, loginAccountRateLimit, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!firebaseWebApiKey) {
            return res.status(503).json({
                message: "Login is temporarily unavailable."
            });
        }

        if (!email || !isAllowedEmailDomain(email)) {
            return res.status(400).json({
                message: "Access restricted: Only valid Gmail (@gmail.com), Yahoo (@yahoo.com), or Microsoft (@outlook.com, @hotmail.com, @live.com) emails can log in."
            });
        }

        const response = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseWebApiKey}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    email: email.trim().toLowerCase(),
                    password: password,
                    returnSecureToken: true
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        res.cookie("sportfit_token", data.idToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: "strict",
            maxAge: 60 * 60 * 1000,
            path: "/"
        });

        res.json({
            message: "Login successful",
            uid: data.localId
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            message: "Login failed"
        });

    }
});

app.post("/logout", (req, res) => {
    res.clearCookie("sportfit_token", {
        httpOnly: true,
        secure: isProduction,
        sameSite: "strict",
        path: "/"
    });
    res.json({ message: "Logout successful" });
});

if (require.main === module) {
    const PORT = 5000;

    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

module.exports = app;