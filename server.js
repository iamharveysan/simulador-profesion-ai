// Google Images (Gemini) — text+image → image (image-to-image preview)
// Requiere API key de Google AI Studio en .env: GOOGLE_API_KEY=xxxx
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
const upload = multer({ storage: multer.memoryStorage() });

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.error("❌ Falta GOOGLE_API_KEY en .env");
  process.exit(1);
}

// Modelo experimental que admite imagen en entrada y salida.
const GOOGLE_IMAGE_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_API_KEY}`;
app.post("/render-edit", upload.single("photo"), async (req, res) => {
  try {
    // Corregimos aquí: el prompt viene de req.body, no del FormData
    const userPrompt = (req.body?.prompt || "Generate a professional portrait").trim();
    const file = req.file;

    if (!file?.buffer) {
      return res.status(400).json({ error: "Falta la foto. Toma una o sube un archivo." });
    }

    const mime = file.mimetype || "image/png";
    const photoBase64 = file.buffer.toString("base64");

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: userPrompt + " — Return only an image, no text or captions." },
            { inlineData: { mimeType: mime, data: photoBase64 } }
          ]
        }
      ],
      generationConfig: {
  responseModalities: ["TEXT", "IMAGE"],
}
    };

    const r = await fetch(GOOGLE_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error("❌ Gemini error:", r.status, data);
      return res.status(r.status).json({ error: data?.error?.message || data?.raw || "Google Images API error" });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    let b64 = null;

    if (parts[0]?.inlineData?.data) b64 = parts[0].inlineData.data;

    if (!b64) {
      const p = parts.find(p => p?.inlineData?.data);
      if (p) b64 = p.inlineData.data;
    }

    if (!b64) {
      const textPart = parts.find(p => typeof p?.text === "string")?.text;
      if (textPart) {
        console.warn("⚠️ El modelo respondió con texto en vez de imagen:", textPart);
        return res.status(502).json({
          error: "Gemini devolvió texto en lugar de imagen. Ajusta el prompt o revisa el modelo/endpoint.",
          hint: textPart
        });
      }
    }

    if (!b64) {
      console.error("⚠️ Respuesta sin imagen reconocible:", JSON.stringify(data, null, 2));
      return res.status(500).json({ error: "API no devolvió imagen; revisa el log para ver la estructura." });
    }

    res.json({ image_base64: b64 });
  } catch (err) {
    console.error("❌ Servidor (Google):", err);
    res.status(500).json({ error: "Fallo al generar imagen con Google Images API." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Google Images server on http://localhost:${PORT}`);
});
