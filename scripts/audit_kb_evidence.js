const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const kb = JSON.parse(fs.readFileSync(path.join(root, 'output', 'gas', 'kb_index.json'), 'utf8'));
const internal = /全傳染病線上互動平台|GitHubPages規格|串接規格|聊天機器人回答行為規則|9千列版回補/i;
const issues = [];

(kb.entries || []).forEach((entry, index) => {
  const source = String(entry.source || '').trim();
  const title = String(entry.title || '').trim();
  const text = String(entry.text || '').trim();
  const reasons = [];
  if (!source) reasons.push('missing source');
  if (!title) reasons.push('missing title');
  if (!text) reasons.push('missing text');
  if (internal.test(source) || internal.test(title)) reasons.push('internal planning source');
  if (text.length < 20) reasons.push('insufficient content');
  if (reasons.length) issues.push({ index, source, title, reasons });
});

console.log(JSON.stringify({
  totalEntries: (kb.entries || []).length,
  structurallyBacked: (kb.entries || []).length - issues.length,
  issueCount: issues.length,
  issues
}, null, 2));

if (issues.length) process.exitCode = 1;
