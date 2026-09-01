import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';
let db = null;
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

// 1. Send Message Endpoint (POST /api/chat)
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Respond conversationally, warmly, and supportively to the user's message. Do NOT include mood labels or formatting headers.\n\nMessage: "${message}"`;
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      reply: responseText,
      response: responseText
    });
  } catch (error) {
    console.error('Chat Error:', error);
    return res.status(500).json({ reply: 'Failed to generate response from AI.' });
  }
});

// 2. Analyze Mood Endpoint (POST /api/summarize)
const handleSummarize = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const entry = req.body.entry || req.body.message || req.body.text || req.body.reflection || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';

    if (!entry) return res.status(400).json({ error: 'Entry text is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Analyze this journal reflection entry and provide three distinct pieces in raw JSON format matching this exact schema:
{
  "mood": "Single word detected emotion like Happy, Stressed, Reflective, Accomplished, Anxious, Calm",
  "summary": "A 2-3 sentence empathetic summary of what the user is reflecting on.",
  "tip": "One actionable, practical recommendation or coping strategy for the user."
}

Do NOT wrap in markdown code blocks. Output raw JSON only.

Reflection Entry: "${entry}"`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    
    // Clean code formatting tags if returned by model
    rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = {
        mood: "Reflective",
        summary: rawText,
        tip: "Take a moment to relax and take deep breaths."
      };
    }

    // Save reflection result to Firestore
    if (db) {
      try {
        const entryDoc = {
          uid,
          entry,
          mood: parsed.mood,
          summary: parsed.summary,
          tip: parsed.tip,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(entryDoc);
        if (uid !== 'anonymous') {
          await db.collection('users').doc(uid).collection('entries').add(entryDoc);
        }
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    // Match exact JSON key structure expected by index.html (data.current.mood, summary, tip)
    return res.status(200).json({
      success: true,
      current: {
        mood: parsed.mood || 'Reflective',
        summary: parsed.summary || 'Reflection analyzed.',
        tip: parsed.tip || 'Keep journaling daily.'
      }
    });
  } catch (error) {
    console.error('Summarize Error:', error);
    return res.status(500).json({
      error: 'Failed to analyze reflection.',
      current: {
        mood: 'Neutral',
        summary: 'Could not process entry at this moment.',
        tip: 'Please try submitting your reflection again.'
      }
    });
  }
};

app.post('/api/summarize', handleSummarize);
app.post('/api/analyze', handleSummarize);
app.post('/api/journal', handleSummarize);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
