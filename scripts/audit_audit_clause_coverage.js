const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'gas_line_bot', 'audit_clauses.json'), 'utf8'));
const clauses = data.clauses || [];
const expectedIds = [
  '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7',
  '2.1', '2.2', '2.3',
  '3.1', '3.2', '3.3',
  '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7',
  '5.1', '5.2',
];
const issues = [];
const ids = clauses.map((item) => item.id);

for (const id of expectedIds) {
  if (!ids.includes(id)) issues.push({ id, issue: 'missing official clause' });
}
for (const clause of clauses) {
  if (!String(clause.title || '').trim()) issues.push({ id: clause.id, issue: 'missing title' });
  if (!String(clause.focus || '').trim()) issues.push({ id: clause.id, issue: 'missing response focus' });
  if (!String(clause.questions || '').trim()) issues.push({ id: clause.id, issue: 'missing committee questions' });
  if (!(clause.aliases || []).length) issues.push({ id: clause.id, issue: 'missing aliases' });
  if (!(clause.evidence || []).length) issues.push({ id: clause.id, issue: 'missing hospital evidence' });
  if (!(clause.evidence || []).some((item) => /^https:\/\/km\.ntuh\.gov\.tw\//.test(String(item.url || '')))) {
    issues.push({ id: clause.id, issue: 'missing KM URL' });
  }
  if (String(clause.focus || '').trim().length < 35) issues.push({ id: clause.id, issue: 'response focus too short' });
  if ((String(clause.questions || '').match(/？/g) || []).length < 2) issues.push({ id: clause.id, issue: 'committee questions not sufficiently specific' });
  const evidenceNames = new Set();
  for (const item of clause.evidence || []) {
    const name = String(item.name || '').trim();
    const url = String(item.url || '').trim();
    if (!name) issues.push({ id: clause.id, issue: 'blank evidence name' });
    if (evidenceNames.has(name)) issues.push({ id: clause.id, issue: 'duplicate evidence name: ' + name });
    evidenceNames.add(name);
    if (url && !/^https:\/\/km\.ntuh\.gov\.tw\//.test(url)) issues.push({ id: clause.id, issue: 'non-KM or insecure evidence URL: ' + url });
    if (/[A-Z]:\\/i.test(name + ' ' + url)) issues.push({ id: clause.id, issue: 'internal drive path in evidence' });
  }
  const combined = [clause.title, clause.focus, clause.questions]
    .concat((clause.evidence || []).map((item) => item.name))
    .join('\n');
  if (/查核佐證路徑與用途|以下路徑只在|不要主動列出|若使用者問|回答重點|Y:\\/i.test(combined)) {
    issues.push({ id: clause.id, issue: 'internal instruction text leaked into clause content' });
  }
}

console.log(JSON.stringify({
  version: data.version || '',
  expectedClauseCount: expectedIds.length,
  actualClauseCount: clauses.length,
  evidenceItemCount: clauses.reduce((sum, item) => sum + (item.evidence || []).length, 0),
  issueCount: issues.length,
  issues,
}, null, 2));

if (issues.length) process.exitCode = 1;
