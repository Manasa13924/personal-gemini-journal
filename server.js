import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

admin.initializeApp({
  projectId: 'personal-gemini-journal-506905'
});
const db = admin.firestore();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.7-flash';

async function generateContentWithFallback(prompt, generationConfig = {}) {
  const modelsToTry = [PRIMARY_MODEL, FALLBACK_MODEL];
  for (const modelName of modelsToTry) {
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await model.generateContent(prompt);
      } catch (error) {
        const status = error.status || (error.message && error.message.includes('503') ? 503 : null);
        if ((status === 503 || status === 429) && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
        } else if (modelName !== modelsToTry[modelsToTry.length - 1]) {
          break;
        } else {
          throw error;
        }
      }
    }
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint: Chat Message (Enforces isolated userId)
app.post('/api/chat', async (req, res) => {
  const { message, userId } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required. User ID missing.' });
  }
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const result = await generateContentWithFallback(message);
    const responseText = result.response.text();

    await db.collection('users').doc(userId).collection('journals').add({
      user_message: message,
      bot_response: responseText,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ response: responseText });
  } catch (error) {
    console.error('Chat API Error:', error);
    res.status(500).json({ error: error.message || 'Backend server error' });
  }
});

// Endpoint: Mood Analysis (Enforces isolated userId)
app.post('/api/analyze-mood', async (req, res) => {
  const { message, userId } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required. User ID missing.' });
  }
  if (!message) {
    return res.status(400).json({ error: 'Message is required for analysis' });
  }

  const prompt = `
    Analyze the following user reflection entry.
    User Entry: "${message}"

    Return JSON strictly in this format:
    {
      "mood": "Single Word Mood Tag",
      "summary": "One sentence summary of how the user is feeling.",
      "actionable_tip": "One helpful recommendation for the user."
    }
  `;

  try {
    const result = await generateContentWithFallback(prompt, { responseMimeType: 'application/json' });
    const analysisData = JSON.parse(result.response.text());

    await db.collection('users').doc(userId).collection('mood_analysis').add({
      user_message: message,
      analysis: analysisData,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json(analysisData);
  } catch (error) {
    console.error('Analyze API Error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze reflection.' });
  }
});

// Endpoint: User Journal History
app.get('/api/history', async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required. User ID missing.' });
  }

  try {
    const snapshot = await db.collection('users')
      .doc(userId)
      .collection('journals')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    const journals = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ journals });
  } catch (error) {
    console.error('History API Error:', error);
    res.status(500).json({ error: 'Failed to fetch journal history' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
});
