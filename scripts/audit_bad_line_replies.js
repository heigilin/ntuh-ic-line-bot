const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const codePath = path.join(root, 'gas_line_bot', 'Code.gs');
const kbPath = path.join(root, 'output', 'gas', 'kb_index.json');
const code = fs.readFileSync(codePath, 'utf8');
const kbText = fs.readFileSync(kbPath, 'utf8');
const kbData = JSON.parse(kbText);

const props = {
  KB_FOLDER_ID: 'local-test-folder',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
  GEMINI_API_KEY: 'test-gemini-key',
};
const cache = {};

function makeFile(name, text) {
  return {
    getName: () => name,
    getBlob: () => ({ getDataAsString: () => text }),
  };
}

const kbFile = makeFile('kb_index.json', kbText);
const ctx = {
  console,
  Date,
  JSON,
  Math,
  RegExp,
  String,
  Number,
  Object,
  Array,
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty: (key) => Object.prototype.hasOwnProperty.call(props, key) ? props[key] : '',
        setProperty: (key, value) => { props[key] = String(value); },
      };
    },
  },
  CacheService: {
    getScriptCache() {
      return {
        get: (key) => Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null,
        put: (key, value) => { cache[key] = String(value); },
      };
    },
  },
  DriveApp: {
    getFolderById() {
      return {
        getFilesByName(name) {
          let used = false;
          return {
            hasNext: () => !used && name === 'kb_index.json',
            next: () => {
              used = true;
              return kbFile;
            },
          };
        },
      };
    },
  },
  UrlFetchApp: {
    fetch(url, options) {
      if (String(url || '').includes('generativelanguage.googleapis.com')) {
        const payload = options && options.payload ? JSON.parse(options.payload) : {};
        const prompt = payload.contents && payload.contents[0] && payload.contents[0].parts && payload.contents[0].parts[0].text || '';
        if (!prompt.startsWith('Translate the following LINE bot answer into ')) {
          return { getResponseCode: () => 500, getContentText: () => '{}' };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'TRANSLATED: ' + prompt.slice(0, 400) }] } }],
          }),
        };
      }
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    },
  },
  ContentService: {
    MimeType: { TEXT: 'text/plain', JSON: 'application/json' },
    createTextOutput(text) {
      return { setMimeType: () => text };
    },
  },
};

vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: codePath });

const badPatterns = [
  /全傳染病台大感管線上互動/,
  /全傳染病線上互動平台/,
  /GitHub\s*Pages/i,
  /串接規格/,
  /本規劃案建立/,
  /互動式漂白水清消線上計算器/,
  /Web Calculator/i,
  /同義字來自/,
  /已外部化的同義字/,
  /9千列版回補/,
  /kb_index\.json/i,
  /README_Coze/,
  /資料來源：/,
  /\.md\b/i,
  /回答重點[:：]/,
  /回答方向[:：]/,
  /建議回答[:：]/,
  /LINE 回答關鍵字/,
  /^(?:\s*[-·•*]\s*)?(?:民眾版|員工版|同仁版)[:：]/m,
  /你可以先做這幾件事[:：]/,
  /若(?:使用者|同仁)問[:：]/,
];

const prompts = [
  'A流',
  'B流',
  'A流隔離',
  'B流隔離',
  '流感A',
  '流感B',
  'A型流感',
  'B型流感',
  '新型A型流感',
  '新型A型流感通報定義',
  'H5N1疫區',
  'C肝',
  'C肝通報定義',
  '未定型肝炎通報定義',
  '日腦',
  '日腦採檢',
  '流腦',
  '流腦採檢',
  'Hib',
  'IPD',
  'M痘',
  '猴痘',
  '立百',
  '立百病毒感染管制',
  '退伍軍人病感染管制',
  '伊波拉感染管制',
  '疥瘡',
  '水痘解隔',
  '百日咳通報',
  '百日咳通報定義',
  '麻疹',
  '麻疹暴露',
  '德國麻疹病人安置',
  '登革熱',
  '登革熱病人安置',
  '兔熱病',
  '兔熱病暴露',
  'MRSE',
  'MRSE隔離',
  'KP',
  '檢驗出KP',
  'CRE',
  'VRE',
  '內視鏡',
  '透析室清消',
  '清消',
  '通報定義',
  '採檢送驗',
  '解隔標準',
  '奈及利亞有何特殊傳染病',
  '非洲可以去嗎',
  '去東南亞要注意什麼',
  '你真好',
  '你不好聊',
];

// Sweep disease-like synonym topics through the common response directions.
// General intent/category keys are excluded because combinations such as
// "診斷碼清消" are not disease questions and should not dilute this audit.
const responseDirections = ['病人安置', '隔離', '採檢送驗', '清消', '解隔', '通報定義'];
const nonDiseaseTopics = new Set([
  '通報', '診斷要件', '診斷碼', '檢體', '疫區', '隔離', '解隔', '外出檢查',
  '清消', '透析室', '抗藥菌', '藥物', '民眾衛教', '標記註記', '感管查核',
  '員工健康', '值班聯絡', '月報', '週會', '咳嗽', '發燒', '皮疹'
]);
Object.keys(kbData.synonyms || {}).forEach((topic) => {
  if (nonDiseaseTopics.has(topic)) return;
  responseDirections.forEach((direction) => prompts.push(topic + direction));
});
const uniquePrompts = Array.from(new Set(prompts));

function setUser(userId) {
  props['user_state_' + userId] = JSON.stringify({ identity: 'staff', language: 'zh-TW' });
}

function ask(question, index) {
  const userId = 'audit' + index;
  setUser(userId);
  const answer = ctx.answerQuestion_(question, { source: { userId } });
  const text = String(ctx.sanitizeLineText_(ctx.normalizeTravelLevelText_(answer.text || '')) || '');
  const matched = badPatterns.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
  const dialysisLeakSignature = /血液透析室或洗腎室清潔消毒|具 COVID-19 感染風險之透析患者|透析機與器械|人工腎臟內部發生血液滲漏/;
  if (/清消|消毒/.test(question) && !/透析室|血液透析|洗腎室|透析機|人工腎臟/.test(question) && dialysisLeakSignature.test(text)) {
    matched.push('cross-topic dialysis cleaning leakage');
  }
  return {
    question,
    diseaseName: answer.diseaseName || '',
    badPatternCount: matched.length,
    matched,
    preview: text.replace(/\s+/g, ' ').slice(0, 220),
  };
}

const results = uniquePrompts.map(ask);
const bad = results.filter((item) => item.badPatternCount > 0);

console.log(JSON.stringify({
  total: results.length,
  badCount: bad.length,
  bad,
}, null, 2));

if (bad.length) process.exitCode = 1;
