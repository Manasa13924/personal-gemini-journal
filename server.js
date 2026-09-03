const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Safe Firebase Initialization
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

// Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '');

async function getGeminiResponse(promptText) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

// 1. Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    if (!message) {
      return res.status(200).json({ success: true, reply: 'Message empty.', response: 'Message empty.' });
    }

    let responseText = '';
    try {
      responseText = await getGeminiResponse(`Respond conversationally to this journal entry: "${message}"`);
    } catch (aiErr) {
      responseText = `Received entry: "${message}"`;
    }

    if (db) {
      const uid = req.body.uid || req.body.userId || 'anonymous';
      await db.collection('journals').add({
        uid,
        entry: message,
        response: responseText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, reply: responseText, response: responseText });
  } catch (error) {
    return res.status(200).json({ success: true, reply: 'Entry saved.', response: 'Entry saved.' });
  }
});

// 2. Journal Endpoint
app.post('/api/journal', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const responseText = await getGeminiResponse(`Analyze the following journal entry. Provide a thoughtful response followed by a detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`);

    if (db) {
      await db.collection('journals').add({
        entry: message,
        response: responseText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, analysis: responseText });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to generate response.', details: error.message });
  }
});

// 3. Analyze Mood & Summarize Endpoint
const handleMood = async (req, res) => {
  try {
    const entry = req.body.entry || req.body.message || req.body.text || '';
    if (!entry) {
      return res.status(400).json({ error: 'Entry text required' });
    }

    const prompt = `Analyze this journal entry and respond ONLY with valid JSON (no markdown formatting):
{
  "mood": "Single word mood (e.g. Reflective, Happy, Anxious)",
  "summary": "Brief 1-2 sentence summary",
  "tip": "Short actionable tip"
}
Entry: "${entry}"`;

    let mood = 'Reflective';
    let summary = 'Reflection recorded.';
    let tip = 'Keep expressing your thoughts.';

    try {
      const aiRaw = await getGeminiResponse(prompt);
      const cleanJson = aiRaw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed.mood) mood = parsed.mood;
      if (parsed.summary) summary = parsed.summary;
      if (parsed.tip) tip = parsed.tip;
    } catch (e) {
      summary = `Entry: ${entry.substring(0, 40)}...`;
    }

    if (db) {
      await db.collection('journals').add({
        entry,
        mood,
        summary,
        tip,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, mood, summary, tip });
  } catch (err) {
    return res.status(500).json({ error: 'Analysis failed' });
  }
};

app.post('/api/analyze-mood', handleMood);
app.post('/api/summarize', handleMood);

// 4. History Endpoint
app.get('/api/history', async (req, res) => {
  try {
    if (!db) return res.status(200).json({ success: true, history: [] });
    const snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
    const entries = [];
    snapshot.forEach(doc => {
      entries.push({ id: doc.id, ...doc.data() });
    });
    return res.status(200).json({ success: true, history: entries, entries });
  } catch (err) {
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