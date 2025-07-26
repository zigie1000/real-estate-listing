// server.js - FULL Production File

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { exec } = require('child_process');
const OpenAI = require('openai');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const { supabase } = require('./licenseManager');
const { checkTier } = require('./tierControl');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/webhook', express.raw({ type: 'application/json' }), require('./stripeWebhook'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function validateLicense(req, res, next) {
  const email = req.query.email || req.body.email || req.headers['x-user-email'];
  const licenseKey = req.query.licenseKey || req.body.licenseKey;
  let tier = 'free';
  let result = { tier: 'free', status: 'inactive' };

  try {
    // --- License lookup by licenseKey (optional, only if you support it) ---
    if (licenseKey) {
      const { data } = await supabase
        .from('licenses')
        .select('license_type, expires_at, status, email')
        .eq('license_key', licenseKey)
        .order('created_at', { ascending: false })
        .limit(1);

      if (data && data[0]) {
        const now = new Date();
        const expiresAt = new Date(data[0].expires_at);
        if (data[0].status === 'active' && expiresAt > now) {
          tier = data[0].license_type || 'free';
          result = {
            tier,
            status: data[0].status,
            email: data[0].email,
            licenseKey
          };
        }
      }
    }
    // --- Fallback: Lookup by email ---
    else if (email) {
      const { data } = await supabase
        .from('licenses')
        .select('license_type, expires_at, status, license_key, email')
        .eq('email', email)
        .order('created_at', { ascending: false })
        .limit(1);

      if (data && data[0]) {
        const now = new Date();
        const expiresAt = new Date(data[0].expires_at);
        if (data[0].status === 'active' && expiresAt > now) {
          tier = data[0].license_type || 'free';
          result = {
            tier,
            status: data[0].status,
            licenseKey: data[0].license_key,
            email: data[0].email
          };
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ License validation failed:", err.message);
  }

  req.userTier = tier;
  req.licenseInfo = result;
  next();
}

// --- Validate License endpoint (for FE AJAX) ---
app.get('/validate-license', validateLicense, (req, res) => {
  // For frontend, always return tier + status (+ key/email if found)
  res.json(req.licenseInfo || { tier: req.userTier, status: 'inactive' });
});

// --- Health Check ---
app.get('/health', (req, res) => {
  res.status(200).send('✅ Server is healthy');
});

// --- Reset License (dev tool only, not prod!) ---
app.get('/reset-license', (req, res) => {
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage", "executionContexts"');
  res.send('✅ License reset.');
});

// --- OpenAI Listing Generation ---
app.post("/generate", validateLicense, async (req, res) => {
  const userPrompt = req.body.prompt;
  console.log("🧠 Prompt received:", userPrompt);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a real estate listing generator." },
        { role: "user", content: `Write a professional real estate listing: ${userPrompt}` }
      ],
      max_tokens: 300
    });

    const output = response.choices[0].message.content.trim();
    console.log("✅ OpenAI response:", output);
    res.json({ result: output });
  } catch (e) {
    console.error("❌ OpenAI error:", e.response?.data || e.message || e);
    res.status(500).json({ result: "Error generating listing." });
  }
});

// --- Export Word (Pro only) ---
app.post("/export-word", validateLicense, checkTier('pro'), (req, res) => {
  const { content, logo, images } = req.body;
  if (!content) return res.status(400).send("No content provided");

  const inputTextPath = "/tmp/input.txt";
  const logoPath = "/tmp/logo.png";
  const outputPath = "/tmp/PromptAgentHQ_Listing.docx";

  fs.writeFileSync(inputTextPath, content);

  if (logo && logo.startsWith("data:image")) {
    const logoBase64 = logo.split(",")[1];
    fs.writeFileSync(logoPath, Buffer.from(logoBase64, "base64"));
  }

  const imagePaths = [];
  if (Array.isArray(images)) {
    images.forEach((imgData, index) => {
      if (imgData.startsWith("data:image")) {
        const imgBase64 = imgData.split(",")[1];
        const imgPath = `/tmp/image_${index + 1}.png`;
        fs.writeFileSync(imgPath, Buffer.from(imgBase64, "base64"));
        imagePaths.push(imgPath);
      }
    });
  }

  const imageArgs = imagePaths.map(p => `"${p}"`).join(" ");
  const cmd = `python3 generate_docx.py "${inputTextPath}" "${logoPath}" ${imageArgs}`;

  exec(cmd, (err, stdout, stderr) => {
    if (err || !fs.existsSync(outputPath)) {
      console.error("❌ DOCX error:", err?.message || 'Missing output');
      return res.status(500).send("DOCX generation failed.");
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename=PromptAgentHQ_Listing.docx");
    res.sendFile(path.resolve(outputPath));
  });
});

// --- Stripe Webhook (handled in stripeWebhook.js, not repeated here) ---

// --- Stripe Update License endpoint (called by webhook) ---
app.post('/stripe/update-license', async (req, res) => {
  const { email, plan, license_type, stripe_customer, stripe_product } = req.body;

  if (!email || !plan || !license_type || !stripe_customer || !stripe_product) {
    return res.status(400).json({ error: "Missing required license fields" });
  }

  try {
    const { data, error: selectError } = await supabase
      .from('licenses')
      .select('id')
      .eq('email', email)
      .limit(1);

    if (selectError) throw selectError;

    const licenseData = {
      plan,
      license_type,
      stripe_customer,
      stripe_product,
      status: 'active',
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    };

    if (data && data.length > 0) {
      const { error: updateError } = await supabase
        .from('licenses')
        .update(licenseData)
        .eq('email', email);

      if (updateError) throw updateError;
      return res.status(200).send('✅ License updated');
    } else {
      const { error: insertError } = await supabase
        .from('licenses')
        .insert([{ ...licenseData, email, is_active: true }]);

      if (insertError) throw insertError;
      return res.status(200).send('✅ License created');
    }
  } catch (err) {
    console.error("❌ License update/insert error:", err.message);
    res.status(500).json({ error: 'Failed to update license' });
  }
});

// --- Health route for Render ---
app.get("/health", (req, res) => {
  res.status(200).send("✅ OK - Render health check passed.");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
