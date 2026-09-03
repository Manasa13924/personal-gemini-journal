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

// 1. Chat Endpoint (/api/chat)
app.post('/api/chat', async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';
    
    if (!message) {
      return res.status(400).json({ error: 'Message text required' });
    }

    let responseText = '';
    try {
      responseText = await getGeminiResponse(`You are a supportive, warm personal AI companion for journaling. Respond helpfully and conversationally to: "${message}"`);
    } catch (aiErr) {
      console.error('Gemini API Error:', aiErr.message);
      responseText = `I hear you on that. Thanks for sharing your reflection today!`;
    }

    if (db) {
      await db.collection('journals').add({
        uid,
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

// 2. Summarize & Mood Analysis Endpoint (/api/summarize)
app.post('/api/summarize', async (req, res) => {
  try {
    const entry = req.body.entry || req.body.message || req.body.text || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';

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
      await db.collection('journals').add({
        uid,
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

// 3. History Endpoint (/api/history)
app.get('/api/history', async (req, res) => {
  try {
    const uid = req.query.uid;
    if (!db) return res.status(200).json({ success: true, history: [] });

    let query = db.collection('journals').orderBy('timestamp', 'desc');
    if (uid) {
      query = query.where('uid', '==', uid);
    }
    
    const snapshot = await query.limit(20).get();
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