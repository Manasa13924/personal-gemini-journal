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

// Serve static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Initialize Firebase Admin SDK
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

// Core Gemini Handler
const handleJournalRequest = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ 
        error: 'Missing GEMINI_API_KEY on Render server settings.' 
      });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || req.body.reflection;

    if (!message) {
      return res.status(400).json({ error: 'Message or reflection entry is required' });
    }

    const prompt = `Analyze the following journal entry. Provide a thoughtful response followed by a detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`;
    
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Optionally store to Firestore if database is connected
    if (db) {
      try {
        await db.collection('journals').add({
          message,
          response: responseText,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (dbErr) {
        console.warn('Could not save entry to Firestore:', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      analysis: responseText,
      mood: responseText,
      response: responseText,
      reply: responseText,
      result: responseText,
      history: []
    });
  } catch (error) {
    console.error('Gemini Execution Error:', error);
    return res.status(500).json({
      error: 'Failed to generate response from Gemini AI.',
      details: error.message
    });
  }
};

// GET endpoint to return journal history
const handleGetHistory = async (req, res) => {
  try {
    if (!db) {
      return res.status(200).json({ success: true, history: [], entries: [], data: [] });
    }
    const snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
    const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    return res.status(200).json({
      success: true,
      history,
      entries: history,
      data: history
    });
  } catch (error) {
    console.error('Fetch History Error:', error.message);
    return res.status(200).json({ success: true, history: [], entries: [], data: [] });
  }
};

// POST routes
app.post('/api/journal', handleJournalRequest);
app.post('/api/chat', handleJournalRequest);
app.post('/api/analyze', handleJournalRequest);

// GET history routes
app.get('/api/journal', handleGetHistory);
app.get('/api/chat', handleGetHistory);
app.get('/api/history', handleGetHistory);
app.get('/api/logs', handleGetHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
