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

// 1. CHAT ENDPOINT
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ reply: 'Missing GEMINI_API_KEY on Render.' });

    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    if (!message) return res.status(400).json({ reply: 'Message content is empty.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Respond conversationally and supportively to this user message:\n\n"${message}"`;
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

// 2. MOOD ANALYZER ENDPOINT (Supports both flat and nested JSON response formats)
const handleSummarize = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const errObj = { mood: 'Error', summary: 'Missing GEMINI_API_KEY.', tip: 'Add API key on Render.' };
      return res.status(500).json({ success: false, ...errObj, current: errObj });
    }

    const entry = req.body.entry || req.body.message || req.body.text || req.body.reflection || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';

    if (!entry) {
      const emptyObj = { mood: 'Empty', summary: 'No text provided.', tip: 'Type a reflection first.' };
      return res.status(400).json({ success: false, ...emptyObj, current: emptyObj });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-3.6-flash',
      generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `Analyze this journal entry and respond strictly in raw JSON with these exact key names:
{
  "mood": "Single-word detected emotion (e.g., Happy, Stressed, Reflective, Accomplished, Anxious, Calm)",
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

    const moodValue = parsed.mood || 'Reflective';
    const summaryValue = parsed.summary || 'Reflection analyzed successfully.';
    const tipValue = parsed.tip || 'Keep up the daily journaling habit.';

    if (db) {
      try {
        const docData = {
          uid,
          entry,
          mood: moodValue,
          summary: summaryValue,
          tip: tipValue,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(docData);
        if (uid !== 'anonymous') {
          await db.collection('users').doc(uid).collection('entries').add(docData);
        }
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      mood: moodValue,
      summary: summaryValue,
      tip: tipValue,
      current: {
        mood: moodValue,
        summary: summaryValue,
        tip: tipValue
      }
    });
  } catch (error) {
    console.error('Analyze API Error:', error);
    const fallbackObj = { mood: 'Notice', summary: 'Failed to process request cleanly.', tip: 'Click Analyze Mood once more.' };
    return res.status(500).json({
      success: false,
      ...fallbackObj,
      current: fallbackObj
    });
  }
};

app.post('/api/summarize', handleSummarize);
app.post('/api/analyze-mood', handleSummarize);
app.post('/api/analyze', handleSummarize);
app.post('/api/journal', handleSummarize);

// 3. PAST REFLECTIONS / HISTORY ENDPOINT
const handleHistory = async (req, res) => {
  try {
    if (!db) {
      return res.status(200).json({ success: true, history: [], journals: [] });
    }

    const uid = req.query.uid || req.query.userId || 'anonymous';
    let snapshot;

    if (uid !== 'anonymous') {
      snapshot = await db.collection('users').doc(uid).collection('entries').orderBy('timestamp', 'desc').limit(20).get();
      if (snapshot.empty) {
        snapshot = await db.collection('journals').where('uid', '==', uid).get();
      }
    } else {
      snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
    }

    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      entries.push({
        id: doc.id,
        entry: data.entry || '',
        mood: data.mood || 'Reflective',
        summary: data.summary || '',
        tip: data.tip || '',
        date: data.timestamp ? data.timestamp.toDate().toLocaleString() : new Date().toLocaleString()
      });
    });

    return res.status(200).json({
      success: true,
      history: entries,
      journals: entries,
      entries: entries
    });
  } catch (error) {
    console.error('History API Error:', error);
    return res.status(500).json({ success: false, history: [], journals: [], entries: [] });
  }
};

app.get('/api/history', handleHistory);
app.get('/api/journals', handleHistory);
app.get('/api/past-reflections', handleHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
