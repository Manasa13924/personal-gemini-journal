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

// 1. CHAT HANDLER (Send Message - Pure conversation, no mood tag)
const handleChatMessage = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const prompt = `You are a helpful and supportive assistant. Respond naturally and helpfully to this message:\n\n"${message}"`;
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      response: responseText,
      reply: responseText,
      message: responseText,
      text: responseText
    });
  } catch (error) {
    console.error('Chat Error:', error);
    return res.status(500).json({ error: 'Failed to process chat message.' });
  }
};

// 2. MOOD ANALYZER HANDLER (Analyze Mood - Specific to journal reflection)
const handleMoodAnalysis = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || req.body.reflection;
    const userId = req.body.userId || req.body.uid || req.body.email || 'mbmanasa777@gmail.com';

    if (!message) return res.status(400).json({ error: 'Reflection text is required' });

    const prompt = `Analyze the following journal entry. Provide a thoughtful supportive analysis, followed by the detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`;
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Determine primary mood string
    let detectedMood = 'Reflective';
    if (/stressed|anxious|overwhelmed/i.test(responseText)) detectedMood = 'Stressed';
    else if (/happy|excited|joy/i.test(responseText)) detectedMood = 'Happy';
    else if (/accomplished|proud|satisfied/i.test(responseText)) detectedMood = 'Accomplished';

    // Store in Firestore for history fetching
    if (db) {
      try {
        const docData = {
          userId,
          message,
          text: message,
          analysis: responseText,
          mood: detectedMood,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(docData);
        await db.collection('users').doc(userId).collection('entries').add(docData);
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      analysis: responseText,
      mood: detectedMood,
      detectedMood: detectedMood,
      response: responseText,
      reply: responseText
    });
  } catch (error) {
    console.error('Analysis Error:', error);
    return res.status(500).json({ error: 'Failed to analyze reflection.' });
  }
};

// 3. HISTORY HANDLER (Loads past reflections for logged-in user)
const handleGetHistory = async (req, res) => {
  try {
    const userId = req.query.userId || req.query.uid || req.query.email || 'mbmanasa777@gmail.com';
    let history = [];

    if (db) {
      let snapshot = await db.collection('users').doc(userId).collection('entries').orderBy('timestamp', 'desc').limit(20).get();
      if (snapshot.empty) {
        snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
      }
      if (!snapshot.empty) {
        history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      }
    }

    return res.status(200).json({
      success: true,
      history,
      entries: history,
      data: history
    });
  } catch (error) {
    return res.status(200).json({ success: true, history: [], entries: [] });
  }
};

// Endpoints mapping
app.post('/api/chat', handleChatMessage);
app.post('/api/journal', handleMoodAnalysis);
app.post('/api/analyze', handleMoodAnalysis);

app.get('/api/journal', handleGetHistory);
app.get('/api/chat', handleGetHistory);
app.get('/api/history', handleGetHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
