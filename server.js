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

// Extract message text from any incoming payload key
const extractMessage = (req) => {
  return req.body.message || 
         req.body.prompt || 
         req.body.text || 
         req.body.entry || 
         req.body.reflection || 
         req.body.content || 
         req.body.input || 
         '';
};

// Extract User ID / Email
const extractUserId = (req) => {
  return req.body.userId || 
         req.body.uid || 
         req.body.email || 
         req.query.userId || 
         req.query.email || 
         'mbmanasa777@gmail.com';
};

// 1. Send Message Handler (Pure Chat - No Mood Tag attached)
const handleChat = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const message = extractMessage(req);
    if (!message) return res.status(400).json({ error: 'Message content is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Respond conversationally, helpfully, and naturally to the user message below. Do NOT append any mood labels or metadata.\n\nMessage: "${message}"`;
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      response: responseText,
      reply: responseText,
      message: responseText,
      text: responseText,
      result: responseText
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ error: 'Failed to process chat message.', details: error.message });
  }
};

// 2. Analyze Mood Handler (Journal Reflection & Mood Detection)
const handleAnalyze = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const message = extractMessage(req);
    const userId = extractUserId(req);

    if (!message) return res.status(400).json({ error: 'Reflection entry text is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Analyze the following journal entry. Provide a supportive, empathetic response analyzing the user's thoughts. At the very end, state the single detected primary mood on its own line in the exact format: "Primary Mood: [Mood]"\n\nEntry: "${message}"`;
    const result = await model.generateContent(prompt);
    let fullText = result.response.text();

    // Extract detected mood
    let detectedMood = 'Reflective';
    const moodMatch = fullText.match(/Primary Mood:\s*\*?([A-Za-z]+)\*?/i);
    if (moodMatch && moodMatch[1]) {
      detectedMood = moodMatch[1];
    } else {
      if (/stressed|anxious|overwhelmed/i.test(fullText)) detectedMood = 'Stressed';
      else if (/happy|excited|joy/i.test(fullText)) detectedMood = 'Happy';
      else if (/accomplished|proud|satisfied/i.test(fullText)) detectedMood = 'Accomplished';
    }

    // Clean response text by stripping the trailing mood label if requested by UI
    const cleanAnalysisText = fullText.replace(/Primary Mood:\s*\*?[A-Za-z]+\*?/gi, '').trim();

    // Store entry in Firestore for history fetching
    if (db) {
      try {
        const docData = {
          userId,
          message,
          text: message,
          reflection: message,
          analysis: cleanAnalysisText,
          response: cleanAnalysisText,
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
      analysis: cleanAnalysisText,
      mood: detectedMood,
      detectedMood: detectedMood,
      response: cleanAnalysisText,
      reply: cleanAnalysisText,
      message: cleanAnalysisText,
      result: cleanAnalysisText,
      data: {
        analysis: cleanAnalysisText,
        mood: detectedMood
      }
    });
  } catch (error) {
    console.error('Analyze API Error:', error);
    return res.status(500).json({ error: 'Failed to analyze reflection.', details: error.message });
  }
};

// 3. Get Reflection History Handler
const handleGetHistory = async (req, res) => {
  try {
    const userId = extractUserId(req);
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

// Map endpoints for Chat (Send Message)
app.post('/api/chat', handleChat);

// Map endpoints for Mood Analysis (Analyze Mood / Save Entry)
app.post('/api/journal', handleAnalyze);
app.post('/api/analyze', handleAnalyze);
app.post('/api/analyze-mood', handleAnalyze);
app.post('/api/mood', handleAnalyze);
app.post('/api/reflection', handleAnalyze);

// Map GET endpoints for History
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
EOFcd ~/personal-gemini-journal

cat << 'EOF' > server.js
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

// Extract message text from any incoming payload key
const extractMessage = (req) => {
  return req.body.message || 
         req.body.prompt || 
         req.body.text || 
         req.body.entry || 
         req.body.reflection || 
         req.body.content || 
         req.body.input || 
         '';
};

// Extract User ID / Email
const extractUserId = (req) => {
  return req.body.userId || 
         req.body.uid || 
         req.body.email || 
         req.query.userId || 
         req.query.email || 
         'mbmanasa777@gmail.com';
};

// 1. Send Message Handler (Pure Chat - No Mood Tag attached)
const handleChat = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const message = extractMessage(req);
    if (!message) return res.status(400).json({ error: 'Message content is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Respond conversationally, helpfully, and naturally to the user message below. Do NOT append any mood labels or metadata.\n\nMessage: "${message}"`;
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      response: responseText,
      reply: responseText,
      message: responseText,
      text: responseText,
      result: responseText
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ error: 'Failed to process chat message.', details: error.message });
  }
};

// 2. Analyze Mood Handler (Journal Reflection & Mood Detection)
const handleAnalyze = async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Missing GEMINI_API_KEY.' });

    const message = extractMessage(req);
    const userId = extractUserId(req);

    if (!message) return res.status(400).json({ error: 'Reflection entry text is required.' });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

    const prompt = `Analyze the following journal entry. Provide a supportive, empathetic response analyzing the user's thoughts. At the very end, state the single detected primary mood on its own line in the exact format: "Primary Mood: [Mood]"\n\nEntry: "${message}"`;
    const result = await model.generateContent(prompt);
    let fullText = result.response.text();

    // Extract detected mood
    let detectedMood = 'Reflective';
    const moodMatch = fullText.match(/Primary Mood:\s*\*?([A-Za-z]+)\*?/i);
    if (moodMatch && moodMatch[1]) {
      detectedMood = moodMatch[1];
    } else {
      if (/stressed|anxious|overwhelmed/i.test(fullText)) detectedMood = 'Stressed';
      else if (/happy|excited|joy/i.test(fullText)) detectedMood = 'Happy';
      else if (/accomplished|proud|satisfied/i.test(fullText)) detectedMood = 'Accomplished';
    }

    // Clean response text by stripping the trailing mood label if requested by UI
    const cleanAnalysisText = fullText.replace(/Primary Mood:\s*\*?[A-Za-z]+\*?/gi, '').trim();

    // Store entry in Firestore for history fetching
    if (db) {
      try {
        const docData = {
          userId,
          message,
          text: message,
          reflection: message,
          analysis: cleanAnalysisText,
          response: cleanAnalysisText,
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
      analysis: cleanAnalysisText,
      mood: detectedMood,
      detectedMood: detectedMood,
      response: cleanAnalysisText,
      reply: cleanAnalysisText,
      message: cleanAnalysisText,
      result: cleanAnalysisText,
      data: {
        analysis: cleanAnalysisText,
        mood: detectedMood
      }
    });
  } catch (error) {
    console.error('Analyze API Error:', error);
    return res.status(500).json({ error: 'Failed to analyze reflection.', details: error.message });
  }
};

// 3. Get Reflection History Handler
const handleGetHistory = async (req, res) => {
  try {
    const userId = extractUserId(req);
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

// Map endpoints for Chat (Send Message)
app.post('/api/chat', handleChat);

// Map endpoints for Mood Analysis (Analyze Mood / Save Entry)
app.post('/api/journal', handleAnalyze);
app.post('/api/analyze', handleAnalyze);
app.post('/api/analyze-mood', handleAnalyze);
app.post('/api/mood', handleAnalyze);
app.post('/api/reflection', handleAnalyze);

// Map GET endpoints for History
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
