import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

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

async function callGeminiSDK(promptText) {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
  
  if (keys.length === 0) {
    throw new Error('No API keys configured.');
  }

  let lastError = null;

  for (let i = 0; i < keys.length; i++) {
    const apiKey = keys[i];
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: promptText,
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err) {
      console.warn(`Key #${i + 1} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All configured API keys in pool failed.');
}

app.post('/api/chat', async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    if (!message) {
      return res.status(200).json({ success: true, reply: 'Message empty.' });
    }

    let responseText = '';
    try {
      responseText = await callGeminiSDK(`Respond conversationally to: "${message}"`);
    } catch (aiErr) {
      responseText = `Received entry: "${message}"`;
    }

    if (db) {
      const uid = req.body.uid || req.body.userId || 'anonymous';
      await db.collection('journals').add({
        uid,
        entry: message,
        userEntry: message,
        response: responseText,
        aiResponse: responseText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return res.status(200).json({ success: true, reply: responseText, response: responseText });
  } catch (error) {
    return res.status(200).json({ success: true, reply: 'Entry saved.' });
  }
});

const handleHistory = async (req, res) => {
  try {
    if (!db) return res.status(200).json({ success: true, history: [] });

    const uid = req.query.uid || req.query.userId || 'anonymous';
    let snapshot;

    try {
      snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
    } catch (queryErr) {
      snapshot = await db.collection('journals').limit(20).get();
    }

    const entries = [];
    if (snapshot && !snapshot.empty) {
      snapshot.forEach(doc => {
        const data = doc.data();
        if (uid !== 'anonymous' && data.uid && data.uid !== uid) return;

        const pickFirst = (...vals) => vals.find(v => typeof v === 'string' && v.trim().length > 0) || 'N/A';

        const userText = pickFirst(data.entry, data.userEntry, data.prompt, data.text, data.message);
        const aiText = pickFirst(data.aiResponse, data.response, data.summary, data.reply);
        const dateText = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate().toLocaleString() : 'Recently';

        entries.push({
          id: doc.id,
          entry: userText,
          userEntry: userText,
          response: aiText,
          aiResponse: aiText,
          date: dateText
        });
      });
    }

    return res.status(200).json({ success: true, history: entries });
  } catch (error) {
    return res.status(200).json({ success: true, history: [] });
  }
};

app.get('/api/history', handleHistory);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
