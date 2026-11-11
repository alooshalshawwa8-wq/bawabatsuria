const MAX_MESSAGE_LENGTH = 2000;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'المساعد الذكي غير مهيأ بعد على الخادم.' });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'أرسل سؤالاً صحيحاً لا يتجاوز 2000 حرف.' });
  }

  try {
    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: 'أنت المساعد الشامي في بوابة سورية الوطنية. أجب بالعربية الواضحة وبلهجة شامية لطيفة عند ملاءمتها. كن دقيقاً ومختصراً. لا تختلق أسعاراً أو مواعيد أو إجراءات رسمية؛ نبّه المستخدم إلى ضرورة التحقق من الجهات الرسمية عند المعلومات المتغيرة. لا تطلب كلمات مرور أو رموز تحقق أو بيانات بطاقات.'
            }]
          },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 700 }
        }),
        signal: AbortSignal.timeout(25000)
      }
    );

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini API error:', upstream.status, payload?.error?.status || 'unknown');
      return res.status(502).json({ error: 'تعذر الحصول على رد من خدمة الذكاء الاصطناعي حالياً.' });
    }

    const reply = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!reply) {
      return res.status(502).json({ error: 'وصل رد فارغ من خدمة الذكاء الاصطناعي.' });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Gemini request failed:', error?.name || 'unknown');
    return res.status(504).json({ error: 'انتهت مهلة الاتصال؛ حاول مرة أخرى.' });
  }
};
