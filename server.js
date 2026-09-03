const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// Firebase Admin Initialization
// ---------------------------------------------------------------------------
let db = null;
try {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.warn('Firebase warning (running without Firestore):', error.message);
}

// ---------------------------------------------------------------------------
// Auth middleware — verifies the Firebase ID token sent from the frontend.
// uid is ALWAYS taken from the verified token, never from the request body
// or query string. This is what prevents one user from reading/writing
// another user's data.
// ---------------------------------------------------------------------------
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing ID token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return res.status(401).json({ error: 'Unauthorized: invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Gemini call via the OpenAI-compatible endpoint.
//
// Google's newer "Auth keys" (prefix AQ.) are currently rejected by the
// native generativelanguage.googleapis.com generateContent endpoint with a
// 401 ACCESS_TOKEN_TYPE_UNSUPPORTED error — this is a known, unresolved
// Google-side rollout issue affecting many developers as of Sep 2026.
// The OpenAI-compatible endpoint accepts the same key via a standard Bearer
// header and works around it. This also works fine with older AIza keys.
// ---------------------------------------------------------------------------
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function getGeminiResponse(promptText) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: promptText }]
          })
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API error ${response.status} (model ${model}): ${errText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error(`Empty response from model ${model}`);
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`Gemini model ${model} failed, trying next fallback if available:`, err.message);
    }
  }

  throw lastError || new Error('All Gemini model attempts failed');
}

// ---------------------------------------------------------------------------
// 1. Chat Endpoint (/api/chat) — requires a verified ID token
// ---------------------------------------------------------------------------
app.post('/api/chat', verifyAuth, async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    const uid = req.uid; // trusted, from verified token — never from req.body

    if (!message) {
      return res.status(400).json({ error: 'Message text required' });
    }

    let responseText = '';
    try {
      responseText = await getGeminiResponse(
        `You are a supportive, warm personal AI companion for journaling. Respond helpfully and conversationally to: "${message}"`
      );
    } catch (aiErr) {
      console.error('Gemini API Error:', aiErr.message);
      responseText = `I hear you on that. Thanks for sharing your reflection today!`;
    }

    if (db) {
      await db.collection('users').doc(uid).collection('journals').add({
        entry: message,
        response: responseText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, reply: responseText, response: responseText });
  } catch (error) {
    console.error('Chat endpoint error:', error);
    return res.status(500).json({ error: 'Failed to process chat message' });
  }
});

// ---------------------------------------------------------------------------
// 2. Summarize & Mood Analysis Endpoint (/api/summarize) — requires auth
// ---------------------------------------------------------------------------
app.post('/api/summarize', verifyAuth, async (req, res) => {
  try {
    const entry = req.body.entry || req.body.message || req.body.text || '';
    const uid = req.uid;

    if (!entry) {
      return res.status(400).json({ error: 'Entry text required' });
    }

    const prompt = `Analyze this journal entry and respond ONLY with valid JSON using exactly these keys: "mood", "summary", and "tip". Do not use markdown backticks.
{
  "mood": "Single word mood (e.g. Reflective, Happy, Anxious, Accomplished)",
  "summary": "Brief 1-2 sentence summary",
  "tip": "Short actionable tip"
}
Entry: "${entry}"`;

    let mood = 'Reflective';
    let summary = `Entry: ${entry.substring(0, 60)}...`;
    let tip = 'Take a moment to breathe and focus on your goals.';

    try {
      const aiRaw = await getGeminiResponse(prompt);
      const cleanJson = aiRaw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed.mood) mood = parsed.mood;
      if (parsed.summary) summary = parsed.summary;
      if (parsed.tip) tip = parsed.tip;
    } catch (e) {
      console.error('JSON parse fallback used:', e.message);
    }

    if (db) {
      await db.collection('users').doc(uid).collection('journals').add({
        entry,
        mood,
        summary,
        tip,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, mood, summary, tip });
  } catch (err) {
    return res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. History Endpoint (/api/history) — requires auth, scoped to caller's uid
// ---------------------------------------------------------------------------
app.get('/api/history', verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    if (!db) return res.status(200).json({ success: true, history: [] });

    const snapshot = await db
      .collection('users').doc(uid).collection('journals')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      let formattedDate = 'Recent Reflection';
      if (data.timestamp && data.timestamp.toDate) {
        formattedDate = data.timestamp.toDate().toLocaleString();
      }
      entries.push({
        id: doc.id,
        ...data,
        date: formattedDate
      });
    });

    return res.status(200).json({ success: true, history: entries, journals: entries });
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(200).json({ success: true, history: [] });
  }
});

// Root Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
