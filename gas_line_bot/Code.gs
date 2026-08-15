const CONFIG = {
  KB_FILE_NAME: 'kb_index.json',
  MAX_HITS: 6,
  MIN_ANSWER_SCORE: 8,
  MIN_SUGGEST_SCORE: 3,
  MAX_CONTEXT_CHARS: 9000,
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
};

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'ntuh-ic-line-gas' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const body = e.postData && e.postData.contents ? e.postData.contents : '';
  if (!verifyWebhookToken_(e)) {
    return json_({ ok: false, error: 'Invalid webhook token' });
  }
  const signature = getHeader_(e, 'x-line-signature');
  if (shouldVerifyLineSignature_() && !verifyLineSignature_(body, signature)) {
    return json_({ ok: false, error: 'Invalid LINE signature' });
  }

  const payload = JSON.parse(body || '{}');
  const events = payload.events || [];
  events.forEach(function(event) {
    if (event.type !== 'message') return;
    if (!event.message || event.message.type !== 'text') return;
    const replyToken = event.replyToken;
    const question = String(event.message.text || '').trim();
    if (!replyToken || !question) return;
    const answer = answerQuestion_(question);
    replyToLine_(replyToken, answer);
  });

  return json_({ ok: true });
}

function answerQuestion_(question) {
  const hits = searchKb_(question, CONFIG.MAX_HITS);
  if (!hits.length || Number(hits[0]._score || 0) < CONFIG.MIN_SUGGEST_SCORE) {
    return '目前知識庫沒有找到足夠相關內容，建議先洽感染管制中心確認。\n\n提醒：請不要在 LINE 輸入病人姓名、病歷號、床號或可識別個資。';
  }
  if (Number(hits[0]._score || 0) < CONFIG.MIN_ANSWER_SCORE) {
    return suggestTopics_(question, hits);
  }
  const context = buildContext_(hits, CONFIG.MAX_CONTEXT_CHARS);
  const geminiAnswer = callGemini_(question, context);
  if (geminiAnswer) return truncateLine_(geminiAnswer);
  return truncateLine_(extractiveAnswer_(hits));
}

function searchKb_(question, limit) {
  const kb = loadKb_();
  const qTokens = expandTokens_(tokenize_(question), kb.synonyms || {});
  const compactQuestion = question.replace(/\s+/g, '').toLowerCase();
  const scored = [];

  kb.entries.forEach(function(entry) {
    const haystack = (entry.source + '\n' + entry.title + '\n' + entry.text).toLowerCase();
    let score = 0;
    qTokens.forEach(function(token) {
      if (haystack.indexOf(token) >= 0) score += token.length >= 3 ? 3 : 1;
      if (String(entry.title).toLowerCase().indexOf(token) >= 0) score += 5;
      if (String(entry.source).toLowerCase().indexOf(token) >= 0) score += 4;
    });
    if (compactQuestion && haystack.replace(/\s+/g, '').indexOf(compactQuestion) >= 0) score += 20;
    if (score > 0) scored.push({ score: score, entry: entry });
  });

  scored.sort(function(a, b) { return b.score - a.score; });
  return scored.slice(0, limit).map(function(item) {
    const copied = {};
    Object.keys(item.entry).forEach(function(key) { copied[key] = item.entry[key]; });
    copied._score = item.score;
    return copied;
  });
}

function expandTokens_(tokens, synonyms) {
  const expanded = tokens.slice();
  const compact = tokens.join('');
  Object.keys(synonyms || {}).forEach(function(key) {
    const values = synonyms[key] || [];
    const keyLower = String(key).toLowerCase();
    const allTerms = [key].concat(values).map(function(v) { return String(v).toLowerCase(); });
    const matched = allTerms.some(function(term) {
      return compact.indexOf(term.replace(/\s+/g, '')) >= 0 || tokens.indexOf(term) >= 0;
    });
    if (!matched) return;
    tokenize_(keyLower + ' ' + values.join(' ')).forEach(function(token) {
      expanded.push(token);
    });
  });
  const seen = {};
  return expanded.filter(function(token) {
    if (seen[token]) return false;
    seen[token] = true;
    return true;
  }).slice(0, 180);
}

function suggestTopics_(question, hits) {
  const seen = {};
  const lines = [];
  hits.slice(0, 5).forEach(function(entry) {
    const title = String(entry.title || '').replace(/^#+\s*/, '');
    const source = String(entry.source || '');
    const key = title + source;
    if (seen[key]) return;
    seen[key] = true;
    lines.push('- ' + title + '（' + source + '）');
  });
  return '我找到一些可能相關的資料，但命中度不夠高，為避免誤答，請您再補一句想問的方向，例如「通報流程」、「送驗檢體」、「隔離/解隔」、「疫區」、「清消濃度」。\n\n可能相關主題：\n' +
    lines.join('\n') +
    '\n\n提醒：請不要在 LINE 輸入病人姓名、病歷號、床號或可識別個資。';
}

function loadKb_() {
  const cached = CacheService.getScriptCache().get('kb_index_v1');
  if (cached) return JSON.parse(cached);

  const folderId = getProp_('KB_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName(CONFIG.KB_FILE_NAME);
  if (!files.hasNext()) throw new Error('Cannot find ' + CONFIG.KB_FILE_NAME);
  const text = files.next().getBlob().getDataAsString('UTF-8');
  const parsed = JSON.parse(text);

  const slim = JSON.stringify(parsed);
  if (slim.length < 90000) {
    CacheService.getScriptCache().put('kb_index_v1', slim, 300);
  }
  return parsed;
}

function buildContext_(hits, maxChars) {
  let context = '';
  hits.forEach(function(entry, index) {
    const block = '[' + (index + 1) + '] ' + entry.title + '\n來源：' + entry.source + '\n' + entry.text + '\n\n';
    if ((context + block).length <= maxChars) context += block;
  });
  return context;
}

function callGemini_(question, context) {
  const apiKey = getProp_('GEMINI_API_KEY', true);
  if (!apiKey) return '';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const prompt =
    '你是台大感管中心的 LINE 臨床問答助手。請用繁體中文、專業但親切的語氣回答臨床同仁。' +
    '只能根據提供的知識庫內容回答；若資料不足，請說明目前知識庫沒有足夠資訊，並建議洽感染管制中心或依院內最新規範確認。' +
    '不要編造固定解隔天數、藥物劑量或不存在的政策。' +
    '若知識庫段落沒有明確寫到答案，請回答「目前知識庫未提供明確答案」，不要用一般常識補完。' +
    '回答最後必須列出「資料來源：」並引用命中段落的來源檔名。' +
    '提醒不要在 LINE 輸入病人姓名、病歷號、床號或可識別個資。\n\n' +
    '使用者問題：' + question + '\n\n知識庫內容：\n' + context;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    console.error(res.getContentText());
    return '';
  }
  const data = JSON.parse(res.getContentText());
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return parts && parts.length ? String(parts[0].text || '').trim() : '';
}

function extractiveAnswer_(hits) {
  const sections = hits.slice(0, 4).map(function(entry) {
    const text = String(entry.text || '').split('\n').filter(Boolean).slice(0, 5).join('\n- ');
    return '【' + entry.title + '】\n- ' + text;
  });
  const sources = [];
  hits.forEach(function(entry) {
    if (entry.source && sources.indexOf(entry.source) < 0) sources.push(entry.source);
  });
  return '我先依知識庫內容整理重點如下；若是個案處置，仍請依醫囑與感染管制中心最新規範確認。\n\n' +
    sections.join('\n\n') +
    '\n\n資料來源：' + sources.slice(0, 3).join('、') +
    '\n\n提醒：請不要在 LINE 輸入病人姓名、病歷號、床號或可識別個資。';
}

function replyToLine_(replyToken, text) {
  const token = getProp_('LINE_CHANNEL_ACCESS_TOKEN');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: truncateLine_(text) }],
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    console.error(res.getContentText());
  }
}

function verifyLineSignature_(body, signature) {
  const secret = getProp_('LINE_CHANNEL_SECRET');
  if (!secret || !signature) return false;
  const bytes = Utilities.computeHmacSha256Signature(body, secret);
  const expected = Utilities.base64Encode(bytes);
  return expected === signature;
}

function shouldVerifyLineSignature_() {
  return String(getProp_('VERIFY_LINE_SIGNATURE', true)).toLowerCase() === 'true';
}

function verifyWebhookToken_(e) {
  const expected = getProp_('WEBHOOK_TOKEN', true);
  if (!expected) return true;
  const actual = e.parameter && e.parameter.token ? String(e.parameter.token) : '';
  return actual === expected;
}

function tokenize_(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  const latin = lower.match(/[a-z0-9][a-z0-9_\-./+%]*/g) || [];
  latin.forEach(function(t) { tokens.push(t); });
  const cjk = lower.match(/[\u4e00-\u9fff]{2,}/g) || [];
  cjk.forEach(function(chunk) {
    if (chunk.length <= 12) tokens.push(chunk);
    [2, 3, 4].forEach(function(size) {
      for (let i = 0; i <= chunk.length - size; i++) tokens.push(chunk.slice(i, i + size));
    });
  });
  const seen = {};
  return tokens.filter(function(t) {
    if (seen[t]) return false;
    seen[t] = true;
    return true;
  }).slice(0, 80);
}

function getHeader_(e, name) {
  const headers = e.headers || {};
  const target = name.toLowerCase();
  for (const key in headers) {
    if (String(key).toLowerCase() === target) return headers[key];
  }
  return '';
}

function getProp_(name, optional) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value && !optional) throw new Error('Missing script property: ' + name);
  return value || '';
}

function truncateLine_(text) {
  const limit = 4500;
  text = String(text || '').trim();
  return text.length <= limit ? text : text.slice(0, limit - 20) + '\n\n（內容較長，已截短）';
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
