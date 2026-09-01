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

// 1. CHAT ENDPOINT (POST /api/chat) -> matches data.reply
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ reply: 'Missing GEMINI_API_KEY on Render settings.' });

    const message = req.body.message || '';
    if (!message) return res.status(400).json({ reply: 'Message content is empty.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Respond conversationally, naturally, and supportively to this user message. Do not include mood labels or analysis headers:\n\n"${message}"`;
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      reply: responseText
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ reply: 'Could not fetch reply from AI.' });
  }
});

// 2. ANALYZE ENDPOINT (POST /api/summarize) -> matches data.current.{mood, summary, tip}
const handleSummarize = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        current: { mood: 'Error', summary: 'Missing GEMINI_API_KEY.', tip: 'Add API key on Render.' }
      });
    }

    const entry = req.body.entry || req.body.message || '';
    const uid = req.body.uid || 'anonymous';

    if (!entry) {
      return res.status(400).json({
        current: { mood: 'Empty', summary: 'No text was provided to analyze.', tip: 'Type a entry in the box first.' }
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.6-flash',
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `Analyze this journal entry and respond strictly in raw JSON with these exact keys:
{
  "mood": "Single-word detected emotion (e.g. Stressed, Happy, Reflective, Accomplished, Anxious)",
  "summary": "A 2-sentence supportive summary of the entry.",
  "tip": "One concise, practical tip or advice for the user."
}

Journal Entry: "${entry}"`;

    const result = await model.generateContent(prompt);
    let rawText = result.response.text().trim();
    
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parsed = {
        mood: "Reflective",
        summary: rawText,
        tip: "Take deep breaths and focus on one step at a time."
      };
    }

    // Save to Firestore history
    if (db) {
      try {
        const docData = {
          uid,
          entry,
          mood: parsed.mood,
          summary: parsed.summary,
          tip: parsed.tip,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(docData);
        if (uid !== 'anonymous') {
          await db.collection('users').doc(uid).collection('entries').add(docData);
        }
      } catch (dbErr) {
        console.warn('Firestore write omitted:', dbErr.message);
      }
    }

    // Return exact keys expected by index.html line 160-162
    return res.status(200).json({
      success: true,
      current: {
        mood: parsed.mood || 'Reflective',
        summary: parsed.summary || 'Reflection analyzed successfully.',
        tip: parsed.tip || 'Keep up the daily journaling habit.'
      }
    });
  } catch (error) {
    console.error('Analyze API Error:', error);
    return res.status(500).json({
      current: {
        mood: 'Notice',
        summary: 'Failed to process request cleanly.',
        tip: 'Please try clicking Analyze Mood once more.'
      }
    });
  }
};

app.post('/api/summarize', handleSummarize);
app.post('/api/analyze', handleSummarize);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
