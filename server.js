require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const app = express();

/* =========================
   FETCH COMPATIBLE
========================= */
const fetchRequest =
  typeof fetch === "function"
    ? fetch
    : (...args) =>
        import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const EVENT_NAME = process.env.EVENT_NAME || "Experiencia USB Bogotá";
const AUTO_RESET_DAILY =
  String(process.env.AUTO_RESET_DAILY || "false").toLowerCase() === "true";
const ADMIN_RESET_TOKEN = process.env.ADMIN_RESET_TOKEN || "";

/**
 * IMPORTANTE PARA RENDER:
 * apunta esto a tu disco persistente, por ejemplo:
 * STORAGE_DIR=/var/data/usb-app
 *
 * En local, si no existe, usa ./storage
 */
const STORAGE_DIR = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(__dirname, "storage");

const DATA_DIR = path.join(STORAGE_DIR, "data");
const GALLERY_DIR = path.join(STORAGE_DIR, "gallery");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_GALLERY_FILES = Number(process.env.MAX_GALLERY_FILES || 80);

if (!GOOGLE_API_KEY) {
  console.error("❌ Falta GOOGLE_API_KEY en .env");
  process.exit(1);
}

const GOOGLE_IMAGE_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_API_KEY}`;

/* =========================
   DIRS
========================= */
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(GALLERY_DIR, { recursive: true });

/* =========================
   MIDDLEWARES
========================= */
app.use(cors());
app.use(express.json({ limit: "30mb" }));
app.use(express.static(PUBLIC_DIR));

/**
 * La galería sale desde la carpeta persistente
 * así no depende de public/
 */
app.use("/gallery", express.static(GALLERY_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file?.mimetype?.startsWith("image/")) {
      return cb(new Error("Solo se permiten imágenes."));
    }
    cb(null, true);
  },
});

/* =========================
   HELPERS
========================= */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function safeProgramKey(value) {
  return String(value || "programa")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initialStats(eventName = EVENT_NAME) {
  return {
    event_name: eventName,
    last_reset_at: new Date().toISOString(),
    last_reset_day: todayStr(),
    total_images: 0,
    unique_participants: 0,
    program_counts: {},
    clients: {},
    recent_generations: [],
  };
}

function topPrograms(stats) {
  return Object.entries(stats.program_counts || {})
    .map(([key, value]) => ({
      key,
      name: value.name,
      count: value.count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function publicStats(stats) {
  return {
    event_name: stats.event_name || EVENT_NAME,
    last_reset_at: stats.last_reset_at,
    total_images: stats.total_images || 0,
    unique_participants: stats.unique_participants || 0,
    program_counts: stats.program_counts || {},
    top_programs: topPrograms(stats),
    recent_generations: stats.recent_generations || [],
  };
}

async function writeStats(stats) {
  await fsp.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), "utf8");
}

async function readStats() {
  try {
    const raw = await fsp.readFile(STATS_FILE, "utf8");
    let stats = JSON.parse(raw);

    if (AUTO_RESET_DAILY && stats.last_reset_day !== todayStr()) {
      stats = initialStats(stats.event_name || EVENT_NAME);
      await writeStats(stats);
    }

    return stats;
  } catch {
    const stats = initialStats(EVENT_NAME);
    await writeStats(stats);
    return stats;
  }
}

async function pruneGallery(maxFiles = MAX_GALLERY_FILES) {
  try {
    const files = await fsp.readdir(GALLERY_DIR);
    if (files.length <= maxFiles) return;

    const detailed = await Promise.all(
      files.map(async (name) => {
        const full = path.join(GALLERY_DIR, name);
        const stat = await fsp.stat(full);
        return { name, full, mtimeMs: stat.mtimeMs };
      })
    );

    detailed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = detailed.slice(maxFiles);

    await Promise.all(
      toDelete.map((file) => fsp.unlink(file.full).catch(() => {}))
    );
  } catch (err) {
    console.warn("⚠️ No se pudo limpiar galería:", err.message);
  }
}

/* =========================
   ROUTES
========================= */
app.get("/api/dashboard", async (req, res) => {
  try {
    const stats = await readStats();
    res.json(publicStats(stats));
  } catch (err) {
    console.error("❌ Dashboard:", err);
    res.status(500).json({ error: "No fue posible cargar estadísticas." });
  }
});

app.post("/render-edit", upload.single("photo"), async (req, res) => {
  try {
    const userPrompt = (
      req.body?.prompt || "Generate a professional portrait"
    ).trim();

    const file = req.file;
    if (!file?.buffer) {
      return res
        .status(400)
        .json({ error: "Falta la foto. Toma una o sube un archivo." });
    }

    const mime = file.mimetype || "image/png";
    const photoBase64 = file.buffer.toString("base64");

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `${userPrompt}. Preserve the person's identity and facial features. ` +
                `Return only one final image without captions or extra text.`
            },
            {
              inlineData: {
                mimeType: mime,
                data: photoBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
      },
    };

    const response = await fetchRequest(GOOGLE_IMAGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      console.error("❌ Gemini error:", response.status, data);
      return res.status(response.status).json({
        error:
          data?.error?.message ||
          data?.raw ||
          "Google Images API error",
      });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part?.inlineData?.data);

    if (!imagePart) {
      const hint = parts.find((part) => typeof part?.text === "string")?.text;
      console.error("⚠️ Gemini sin imagen:", JSON.stringify(data, null, 2));

      return res.status(502).json({
        error: hint
          ? `Gemini devolvió texto en lugar de imagen: ${hint}`
          : "La API no devolvió una imagen válida.",
      });
    }

    return res.json({
      image_base64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
    });
  } catch (err) {
    console.error("❌ Servidor /render-edit:", err);
    res
      .status(500)
      .json({ error: "Fallo al generar imagen con Google Images API." });
  }
});

app.post("/api/save-generation", async (req, res) => {
  try {
    let stats = await readStats();

    const {
      image_base64,
      program_key,
      program_name,
      client_id,
      phrase,
    } = req.body || {};

    if (!image_base64 || !program_key || !program_name || !client_id) {
      return res
        .status(400)
        .json({ error: "Faltan datos para guardar la participación." });
    }

    const cleanProgramKey = safeProgramKey(program_key);
    const now = new Date().toISOString();

    if (!stats.clients[client_id]) {
      stats.clients[client_id] = {
        first_seen: now,
        last_seen: now,
        generations: 0,
      };
      stats.unique_participants += 1;
    }

    stats.clients[client_id].last_seen = now;
    stats.clients[client_id].generations += 1;

    stats.total_images += 1;

    if (!stats.program_counts[cleanProgramKey]) {
      stats.program_counts[cleanProgramKey] = {
        name: program_name,
        count: 0,
      };
    }

    stats.program_counts[cleanProgramKey].name = program_name;
    stats.program_counts[cleanProgramKey].count += 1;

    const filename = `${Date.now()}_${cleanProgramKey}.png`;
    const filePath = path.join(GALLERY_DIR, filename);

    await fsp.writeFile(filePath, Buffer.from(image_base64, "base64"));

    const entry = {
      id: `gen_${Date.now()}`,
      image_url: `/gallery/${filename}`,
      program_key: cleanProgramKey,
      program_name,
      phrase: phrase || "",
      created_at: now,
      participation_number: stats.total_images,
    };

    stats.recent_generations.unshift(entry);
    stats.recent_generations = stats.recent_generations.slice(0, 12);

    await writeStats(stats);
    await pruneGallery();

    res.json({
      ok: true,
      participation_number: stats.total_images,
      stats: publicStats(stats),
      entry,
    });
  } catch (err) {
    console.error("❌ Guardando participación:", err);
    res
      .status(500)
      .json({ error: "No fue posible registrar la participación." });
  }
});

app.post("/api/admin/reset-event", async (req, res) => {
  try {
    const token = req.body?.token || req.headers["x-admin-token"];

    if (!ADMIN_RESET_TOKEN) {
      return res.status(400).json({
        error: "No configuraste ADMIN_RESET_TOKEN en .env",
      });
    }

    if (token !== ADMIN_RESET_TOKEN) {
      return res.status(401).json({ error: "Token inválido." });
    }

    const newEventName =
      String(req.body?.event_name || EVENT_NAME).trim() || EVENT_NAME;

    const files = await fsp.readdir(GALLERY_DIR).catch(() => []);
    await Promise.all(
      files.map((name) =>
        fsp.unlink(path.join(GALLERY_DIR, name)).catch(() => {})
      )
    );

    const newStats = initialStats(newEventName);
    await writeStats(newStats);

    res.json({
      ok: true,
      stats: publicStats(newStats),
    });
  } catch (err) {
    console.error("❌ Reset event:", err);
    res
      .status(500)
      .json({ error: "No fue posible reiniciar la jornada." });
  }
});

/* =========================
   ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
  if (err?.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

/* =========================
   START
========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ USB server on http://0.0.0.0:${PORT}`);
  console.log(`📦 STORAGE_DIR: ${STORAGE_DIR}`);
  console.log(`🖼️  GALLERY_DIR: ${GALLERY_DIR}`);
  console.log(`📊 STATS_FILE: ${STATS_FILE}`);
});