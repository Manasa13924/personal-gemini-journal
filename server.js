const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Initialize Firebase Admin SDK using Secret File
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google-credentials.json';

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Firebase initialization error:', error.message);
}

// 2. Initialize Gemini AI Client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 3. Journal Endpoint (handles content generation & mood analysis)
app.post('/api/journal', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `Analyze the following journal entry. Provide a thoughtful response followed by a detected primary mood (e.g., Happy, Stressed, Reflective, Accomplished):\n\nEntry: "${message}"`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    return res.status(200).json({
      success: true,
      analysis: responseText
    });
  } catch (error) {
    console.error('Gemini API Error:', error);
    return res.status(500).json({
      error: 'Failed to generate response from Gemini AI.',
      details: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.send('Personal Gemini Journal Backend is Live!');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
