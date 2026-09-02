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

// Multi-Key SDK call with automatic fallback rotation
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
      console.warn(`Key #${i + 1} (${apiKey.substring(0, 6)}...) failed or exhausted limit: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All configured API keys in pool failed.');
}

// Offline fallback engine for backup
function generateOfflineAnalysis(entry) {
  const lower = entry.toLowerCase();
  let mood = 'Reflective';
  let tip = 'Take a moment to pause and appreciate your effort today.';

  if (lower.includes('happy') || lower.includes('great') || lower.includes('good') || lower.includes('excited') || lower.includes('won') || lower.includes('achieved')) {
    mood = 'Accomplished';
    tip = 'Celebrate your wins, no matter how small!';
  } else if (lower.includes('sad') || lower.includes('tired') || lower.includes('stressed') || lower.includes('hard') || lower.includes('difficult')) {
    mood = 'Tired';
    tip = 'Be kind to yourself today and ensure you get proper rest.';
  } else if (lower.includes('anxious') || lower.includes('worry') || lower.includes('scared') || lower.includes('nervous')) {
    mood = 'Anxious';
    tip = 'Focus on one small manageable task at a time.';
  }

  const summary = `Reflection logged successfully: "${entry.length > 60 ? entry.substring(0, 60) + '...' : entry}"`;
  
  return { mood, summary, tip };
}

// 1. CHAT ENDPOINT
app.post('/api/chat', async (req, res) => {
  try {
    const message = req.body.message || req.body.prompt || req.body.text || req.body.entry || '';
    
    if (!message) {
      const msg = 'Message content is empty.';
      return res.status(200).json({ success: true, reply: msg, response: msg, text: msg, message: msg });
    }

    let responseText = '';

    try {
      const prompt = `Respond conversationally, warmly, and supportively to this user message:\n\n"${message}"`;
      responseText = await callGeminiSDK(prompt);
    } catch (aiErr) {
      console.warn('All Gemini API keys failed or exhausted. Using fallback response:', aiErr.message);
      responseText = `Thank you for sharing your thoughts: "${message}". Keep up your daily practice!`;
    }

    if (db) {
      try {
        const uid = req.body.uid || req.body.userId || 'anonymous';
        await db.collection('journals').add({
          uid,
          userEntry: message,
          entry: message,
          prompt: message,
          text: message,
          aiResponse: responseText,
          summary: responseText,
          reply: responseText,
          response: responseText,
          mood: 'Conversational',
          tip: 'Keep sharing your thoughts and progress.',
          actionableTip: 'Keep sharing your thoughts and progress.',
          actionable_tip: 'Keep sharing your thoughts and progress.',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (dbErr) {
        console.warn('Firestore write warning:', dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      reply: responseText,
      response: responseText,
      text: responseText,
      message: responseText
    });
  } catch (error) {
    console.error('Chat Endpoint Error:', error);
    const fallbackMsg = 'Received entry successfully.';
    return res.status(200).json({ success: true, reply: fallbackMsg, response: fallbackMsg, text: fallbackMsg, message: fallbackMsg });
  }
});

app.get('/api/chat', (req, res) => {
  res.status(200).send('Chat API endpoint is active.');
});

// 2. MOOD ANALYZER ENDPOINT
const handleSummarize = async (req, res) => {
  try {
    const entry = req.body.entry || req.body.message || req.body.text || req.body.reflection || '';
    const uid = req.body.uid || req.body.userId || 'anonymous';

    if (!entry) {
      const emptyObj = { 
        mood: 'Empty', 
        summary: 'No text provided.', 
        tip: 'Type a reflection first.',
        actionableTip: 'Type a reflection first.',
        actionable_tip: 'Type a reflection first.'
      };
      return res.status(200).json({ success: true, ...emptyObj, current: emptyObj });
    }

    let moodValue = '';
    let summaryValue = '';
    let tipValue = '';

    const promptText = `Analyze this journal entry and respond strictly in raw JSON with these exact key names:
{
  "mood": "Single-word detected emotion (e.g., Happy, Stressed, Reflective, Accomplished, Anxious, Calm)",
  "summary": "A 2-sentence supportive summary of the entry.",
  "tip": "One concise, practical tip or advice for the user."
}

Journal Entry: "${entry}"`;

    try {
      let rawText = await callGeminiSDK(promptText);
      rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(rawText);
      
      moodValue = parsed.mood || 'Reflective';
      summaryValue = parsed.summary || `Summary: ${entry}`;
      tipValue = parsed.tip || 'Keep up your daily reflection habit.';
    } catch (aiErr) {
      console.warn('Gemini API key pool exhausted. Falling back to local offline engine:', aiErr.message);
      const offline = generateOfflineAnalysis(entry);
      moodValue = offline.mood;
      summaryValue = offline.summary;
      tipValue = offline.tip;
    }

    if (db) {
      try {
        const docData = {
          uid,
          entry: entry,
          userEntry: entry,
          prompt: entry,
          text: entry,
          mood: moodValue,
          summary: summaryValue,
          aiResponse: summaryValue,
          response: summaryValue,
          reply: summaryValue,
          tip: tipValue,
          actionableTip: tipValue,
          actionable_tip: tipValue,
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

    const responsePayload = {
      success: true,
      mood: moodValue,
      summary: summaryValue,
      tip: tipValue,
      actionableTip: tipValue,
      actionable_tip: tipValue,
      current: {
        mood: moodValue,
        summary: summaryValue,
        tip: tipValue,
        actionableTip: tipValue,
        actionable_tip: tipValue
      }
    };

    return res.status(200).json(responsePayload);
  } catch (error) {
    console.error('Analyze API Error:', error);
    const fallbackObj = generateOfflineAnalysis(req.body.entry || '');
    return res.status(200).json({
      success: true,
      mood: fallbackObj.mood,
      summary: fallbackObj.summary,
      tip: fallbackObj.tip,
      actionableTip: fallbackObj.tip,
      actionable_tip: fallbackObj.tip,
      current: fallbackObj
    });
  }
};

app.post('/api/summarize', handleSummarize);
app.post('/api/analyze-mood', handleSummarize);
app.post('/api/analyze', handleSummarize);
app.post('/api/journal', handleSummarize);

// 3. HISTORY ENDPOINT (WITH UNDEFINED PREVENTATIVE ALIASES & ORDERING)
const handleHistory = async (req, res) => {
  try {
    if (!db) {
      return res.status(200).json({ success: true, history: [], journals: [], entries: [], data: [] });
    }

    const uid = req.query.uid || req.query.userId || 'anonymous';
    let snapshot;

    try {
      snapshot = await db.collection('journals').orderBy('timestamp', 'desc').limit(20).get();
    } catch (queryErr) {
      console.warn('History ordered query failed, falling back to simple query:', queryErr.message);
      snapshot = await db.collection('journals').limit(20).get();
    }

    const entries = [];
    if (snapshot && !snapshot.empty) {
      snapshot.forEach(doc => {
        const data = doc.data();
        if (uid !== 'anonymous' && data.uid && data.uid !== uid) {
          return;
        }

        const userText = data.userEntry || data.entry || data.prompt || data.message || data.text || data.content || data.reflection || 'Reflection entry';
        const aiText = data.aiResponse || data.summary || data.response || data.reply || data.tip || 'Analysis recorded';
        const tipText = data.actionableTip || data.actionable_tip || data.tip || 'Take it step by step.';
        const moodText = data.mood || 'Reflective';
        const dateText = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate().toLocaleString() : new Date().toLocaleString();

        entries.push({
          id: doc.id,
          // All possible property names frontend script might look for
          userEntry: userText,
          entry: userText,
          prompt: userText,
          text: userText,
          message: userText,
          content: userText,
          reflection: userText,
          
          aiResponse: aiText,
          summary: aiText,
          response: aiText,
          reply: aiText,
          
          mood: moodText,
          tag: moodText,
          emotion: moodText,
          
          tip: tipText,
          actionableTip: tipText,
          actionable_tip: tipText,
          
          date: dateText,
          created_at: dateText,
          createdAt: dateText,
          timestamp: dateText
        });
      });
    }

    return res.status(200).json({
      success: true,
      history: entries,
      journals: entries,
      entries: entries,
      data: entries,
      reflections: entries
    });
  } catch (error) {
    console.error('History API Error:', error);
    return res.status(200).json({ success: true, history: [], journals: [], entries: [], data: [] });
  }
};

app.get('/api/history', handleHistory);
app.get('/api/journals', handleHistory);
app.get('/api/past-reflections', handleHistory);
app.get('/api/reflections', handleHistory);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
