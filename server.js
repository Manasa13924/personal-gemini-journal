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

// Universal Request Handler for Chat & Mood Analysis
const handleUnifiedRequest = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY on Render settings.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Fallback extraction across all possible key names from frontend
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || req.body.reflection || req.body.content || req.body.input;
    const userId = req.body.userId || req.body.uid || req.body.email || req.query.userId || req.query.email || 'mbmanasa777@gmail.com';

    if (!message) {
      return res.status(400).json({ error: 'Message or entry content is required.' });
    }

    const isAnalyzeRoute = req.path.includes('analyze') || req.path.includes('journal') || req.path.includes('mood');
    
    let prompt = "";
    if (isAnalyzeRoute) {
      prompt = `Provide a thoughtful, empathetic response to the following journal reflection, followed by a separate detected primary mood:\n\nJournal Entry: "${message}"`;
    } else {
      prompt = `Respond conversationally and supportively to the following message:\n\n"${message}"`;
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    let detectedMood = 'Reflective';
    if (/stressed|anxious|overwhelmed/i.test(responseText)) detectedMood = 'Stressed';
    else if (/happy|excited|joy/i.test(responseText)) detectedMood = 'Happy';
    else if (/accomplished|proud|satisfied/i.test(responseText)) detectedMood = 'Accomplished';

    // Store in Firestore for past reflections history
    if (db) {
      try {
        const entryData = {
          userId,
          user: userId,
          email: userId,
          message,
          text: message,
          reflection: message,
          analysis: responseText,
          response: responseText,
          mood: detectedMood,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('journals').add(entryData);
        await db.collection('users').doc(userId).collection('entries').add(entryData);
      } catch (dbErr) {
        console.warn('Firestore write omitted:', dbErr.message);
      }
    }

    // Comprehensive response structure matching all possible frontend keys
    return res.status(200).json({
      success: true,
      analysis: responseText,
      response: responseText,
      reply: responseText,
      message: responseText,
      result: responseText,
      mood: detectedMood,
      detectedMood: detectedMood,
      data: {
        analysis: responseText,
        mood: detectedMood,
        response: responseText
      }
    });
  } catch (error) {
    console.error('Gemini Execution Error:', error);
    return res.status(500).json({
      error: 'Failed to process request.',
      details: error.message
    });
  }
};

// Universal History Fetch Handler
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
      data: history,
      reflections: history
    });
  } catch (error) {
    return res.status(200).json({ success: true, history: [], entries: [], data: [] });
  }
};

// Express Route Mappings for all common frontend API endpoints
app.post('/api/journal', handleUnifiedRequest);
app.post('/api/chat', handleUnifiedRequest);
app.post('/api/analyze', handleUnifiedRequest);
app.post('/api/mood', handleUnifiedRequest);
app.post('/api/reflection', handleUnifiedRequest);

app.get('/api/journal', handleGetHistory);
app.get('/api/chat', handleGetHistory);
app.get('/api/history', handleGetHistory);
app.get('/api/reflections', handleGetHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
