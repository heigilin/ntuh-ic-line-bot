const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const codePath = path.join(root, 'gas_line_bot', 'Code.gs');
const kbPath = path.join(root, 'output', 'gas', 'kb_index.json');
const auditPath = path.join(root, 'gas_line_bot', 'audit_clauses.json');
const clearancePath = path.join(root, 'gas_line_bot', 'clearance_rules.json');
const code = fs.readFileSync(codePath, 'utf8');
const kbText = fs.readFileSync(kbPath, 'utf8');
const auditText = fs.readFileSync(auditPath, 'utf8');
const clearanceText = fs.readFileSync(clearancePath, 'utf8');
const kbData = JSON.parse(kbText);

const props = {
  KB_FOLDER_ID: 'local-test-folder',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
  GEMINI_API_KEY: 'test-gemini-key',
  SUGGESTION_RECORDS: JSON.stringify([{ text: '這是不可由 LINE 讀取的測試意見內容' }]),
};
const cache = {};

function makeFile(name, text) {
  return {
    getName: () => name,
    getBlob: () => ({ getDataAsString: () => text }),
  };
}

const kbFile = makeFile('kb_index.json', kbText);
const auditFile = makeFile('audit_clauses.json', auditText);
const clearanceFile = makeFile('clearance_rules.json', clearanceText);
const meetingFile = makeFile(
  '週會紀錄_檢索記事本_測試.md',
  '2026-08-01｜VRE隔離流程｜測試摘要不得回傳\n2026-08-08｜VRE追蹤｜另一段會議內容不得回傳\n2026-08-15｜感染月報｜月報摘要不得回傳'
);

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
          const fileMap = { 'kb_index.json': kbFile, 'audit_clauses.json': auditFile, 'clearance_rules.json': clearanceFile };
          let used = false;
          return {
            hasNext: () => !used && !!fileMap[name],
            next: () => {
              used = true;
              return fileMap[name];
            },
          };
        },
        getFiles() {
          const files = [kbFile, auditFile, meetingFile];
          let index = 0;
          return {
            hasNext: () => index < files.length,
            next: () => files[index++],
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
          return {
            getResponseCode: () => 500,
            getContentText: () => '{}',
          };
        }
        let translated = 'TRANSLATED: ' + prompt.split('Text:\n').pop().slice(0, 500);
        if (prompt.includes('Bahasa Indonesia')) translated = 'TERJEMAHAN ID: ' + prompt.split('Text:\n').pop().slice(0, 500);
        if (prompt.includes('Tiếng Việt')) translated = 'BAN DICH VI: ' + prompt.split('Text:\n').pop().slice(0, 500);
        if (prompt.includes('English')) translated = 'TRANSLATION EN: ' + prompt.split('Text:\n').pop().slice(0, 500);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: translated }] } }],
          }),
        };
      }
      return {
        getResponseCode: () => 500,
        getContentText: () => '{}',
      };
    },
  },
  ContentService: {
    MimeType: { TEXT: 'text/plain', JSON: 'application/json' },
    createTextOutput(text) {
      return {
        setMimeType: () => text,
      };
    },
  },
};

vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: codePath });

function resetUser(userId, identity) {
  props['user_state_' + userId] = JSON.stringify({
    identity: identity || 'staff',
    language: 'zh-TW',
  });
  delete props['mode_' + userId];
}

function ask(userId, question) {
  const event = { source: { userId } };
  const answer = ctx.answerQuestion_(question, event);
  const qr = ctx.buildQuickReplyForDisease_(answer.diseaseName, answer);
  const labels = qr && qr.items ? qr.items.map((item) => item.action && item.action.label).filter(Boolean) : [];
  const text = String(answer.text || '');
  const sentText = String(ctx.sanitizeLineText_(ctx.normalizeTravelLevelText_(text)) || '');
  return {
    question,
    diseaseName: answer.diseaseName || '',
    text,
    sentText,
    quickReplyLabels: labels,
    state: props['user_state_' + userId] || '',
  };
}

function includesAll(text, expected) {
  return (expected || []).filter((s) => !String(text || '').includes(s));
}

function excludesAll(text, forbidden) {
  return (forbidden || []).filter((s) => String(text || '').includes(s));
}

const cases = [
  {
    id: 'clinical-catheter-care-clarification',
    user: 'clinical-catheter-care',
    q: '導管照護',
    expect: ['導管種類不同', '中心靜脈導管照護', '導尿管照護', '呼吸器管路照護'],
    forbid: ['隔壁床', '先不用太緊張', '一般流程摘要'],
    quick: ['中心導管', '導尿管', '呼吸器'],
  },
  {
    id: 'audit-catheter-care-menu',
    user: 'audit-catheter-care',
    sequence: ['評鑑查核', '導管照護'],
    expect: ['查核條文 1.3', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄'],
    forbid: ['隔壁床', '先不用太緊張', '感染管制處置與規範重點整理'],
    quick: ['條文重點', '委員提問', 'KM佐證', '執行紀錄', '臨床照護'],
    quickNot: ['評鑑查核'],
  },
  {
    id: 'rubella-patient-placement',
    user: 'rubella-placement',
    q: '德國麻疹病人安置',
    expect: ['德國麻疹 病房安排與收治建議', '飛沫隔離', '單人病室', '懷孕婦女', '出疹後 7 天'],
    forbid: ['民眾版', '隔壁床', '你可以先做這幾件事', '回答重點', '感染管制處置與規範重點整理'],
  },
  {
    id: 'rubella-clearance-specific',
    user: 'rubella-clearance',
    q: '德國麻疹解隔標準',
    expect: ['德國麻疹解除隔離重點', '出疹後 7 天', '不要求常規檢驗陰性', '先天性德國麻疹症候群', '隔離至 1 歲', '出生滿 3 個月後', '取消德國麻疹隔離'],
    forbid: ['德國麻疹解隔標準需依疾病別規範判斷', '若要精準判斷', '請改問'],
  },
  {
    id: 'dialysis-disinfection-concentration',
    user: 'dialysis-cleaning',
    q: '透析室消毒濃度',
    expect: ['透析室清潔消毒濃度', '1,000 ppm', '1:50', '小於 10 mL', '5,000 ppm', '設備相容的消毒劑', '內部血液滲漏'],
    forbid: ['回答重點', '不要只回答', '感染管制處置與規範重點整理', '嗅味覺喪失', '至少 2 公尺'],
  },
  {
    id: 'audit-dialysis-disinfection-concentration',
    user: 'audit-dialysis-cleaning',
    sequence: ['評鑑查核', '透析室消毒濃度'],
    expect: ['透析室清潔消毒濃度', '1,000 ppm', '評鑑查核可出示', 'KM：50300-3-000011', '漂白水泡製／濃度與日期標示', '透析機維護', '教育訓練紀錄'],
    forbid: ['回答重點', '不要只回答', '感染管制處置與規範重點整理', 'Y:\\'],
    quick: ['清消標準', '委員提問', '執行紀錄', 'KM佐證', '臨床照護'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置', '採檢送驗', '評鑑查核'],
  },
  {
    id: 'clinical-mode-hides-current-mode-button',
    user: 'clinical-mode-buttons',
    sequence: ['臨床照護', '麻疹通報定義'],
    expect: ['麻疹通報定義查詢重點'],
    quick: ['評鑑查核'],
    quickNot: ['臨床照護'],
  },
  {
    id: 'follow-welcome-scope-boundary',
    user: 'new-follower',
    followWelcome: true,
    expect: ['可查感染管制', '回答方向可隨時切換', '臨床照護', '病人安置', '評鑑查核', '委員可能的提問', 'KM 佐證', '之後仍可切換', '不提供疾病診斷', '醫師推薦', '請勿輸入病人姓名'],
    quick: ['臨床照護', '評鑑查核'],
  },
  {
    id: 'doctor-selection-out-of-scope',
    user: 'doctor-referral',
    q: '發燒咳嗽應該找哪一位醫師',
    expect: ['不提供疾病診斷', '醫師推薦', '台大醫院 App', '急診', '119'],
    forbid: ['未檢索到完全相符', '感染管制小幫手'],
  },
  {
    id: 'influenza-rapid-positive-pcr-negative',
    user: 'flu-discordant',
    q: '流感快篩陽性，PCR陰性，要不要隔離',
    expect: ['需再確認兩項風險', '類流感症狀', '是否為新冠接觸者', '即使無症狀', '較高規格因應'],
    forbid: ['流感 隔離醫囑與病房處置', '每日以 1,000 ppm', '優先單人病室'],
    quick: ['有症狀＋有接觸', '有症狀＋無接觸', '無症狀＋有接觸', '無症狀＋無接觸'],
  },
  {
    id: 'influenza-discordant-asymptomatic-covid-contact',
    user: 'flu-discordant-contact',
    q: '流感快篩陽性、PCR陰性；無症狀；是新冠接觸者',
    expect: ['無症狀但為新冠接觸者', '高風險', '優先單人安置（或 cohorting 同室隔離）', '相同暴露風險的接觸者同室', '不得與無風險者同室', '第二波散播', '健康監測'],
    forbid: ['ANN10039 取消隔離', '需再確認兩項風險'],
  },
  {
    id: 'influenza-discordant-symptomatic-covid-contact',
    user: 'flu-discordant-symptomatic-contact',
    q: '流感快篩陽性、PCR陰性；有類流感症狀；是新冠接觸者',
    expect: ['有類流感症狀且為新冠接觸者', '較高規格呼吸道隔離防護', '優先單人安置（或 cohorting 同室隔離）', '相同暴露風險者同室', '不得與無風險者同室', '新冠及其他呼吸道病原採檢'],
    forbid: ['ANN10039 取消隔離', '需再確認兩項風險'],
  },
  {
    id: 'covid-rapid-test-positive-isolation',
    user: 'covid-positive',
    q: '新冠快篩陽性',
    expect: ['新冠檢驗陽性', '飛沫與接觸隔離', 'ANN00061', '結果互相矛盾'],
    forbid: ['新冠 隔離醫囑與病房處置', '每日以 1,000 ppm'],
  },
  {
    id: 'measles-pcr-positive-isolation',
    user: 'measles-positive',
    q: '麻疹PCR陽性要不要隔離',
    expect: ['麻疹檢驗陽性', '空氣隔離', 'ANN00046'],
    forbid: ['麻疹 隔離醫囑與病房處置', '環境與高頻表面消毒'],
  },
  {
    id: 'vre-culture-positive-isolation',
    user: 'vre-positive-result',
    q: 'VRE培養陽性是否隔離',
    expect: ['VRE檢驗陽性', '接觸隔離', 'ANN00025'],
    forbid: ['VRE 隔離醫囑與病房處置', '環境與高頻表面消毒'],
  },
  {
    id: 'dengue-order',
    user: 'staff1',
    q: '登革熱隔離醫囑',
    expect: ['ANN00049', 'ANN10049'],
    forbid: ['暴露處置', '一般流程摘要｜如與正式公告不一致，以正式公告為準。\n請勿輸入病人姓名', '一般流程摘要｜如與正式公告不一致，以正式公告為準。\n\n請勿輸入病人姓名'],
    quick: ['疫情訊息', '通報定義', '採檢送驗'],
  },
  {
    id: 'dengue-followup',
    user: 'staff2',
    sequence: ['登革熱隔離醫囑', '白話一點'],
    expect: ['ANN00049', 'ANN10049'],
    forbid: ['抱歉，剛剛可能沒有回答到'],
  },
  {
    id: 'vre-isolation',
    user: 'staff3',
    q: '檢驗出VRE的隔離流程',
    expect: ['ANN00025', '接觸隔離', 'VRE'],
    forbid: ['CRE 是', '民眾版'],
  },
  {
    id: 'vre-clear',
    user: 'staff4',
    q: 'VRE的解隔標準',
    expect: ['VRE', '解隔', '肛門', '1 至 2 週', '3 次', '間隔至少 72 小時', '疾管署附錄 A'],
    forbid: ['各菌種解除接觸隔離採檢速查'],
  },
  {
    id: 'mrse',
    user: 'staff5',
    q: 'MRSE隔離',
    expect: ['MRSE', '不須送驗 CDC', '污染、移生或臨床感染'],
    forbid: ['流感病人安置', 'CDCN'],
  },
  {
    id: 'kp',
    user: 'staff6',
    q: '檢驗出KP',
    expect: ['KP', 'Klebsiella', '接觸隔離'],
    forbid: ['狂犬病毒', '防疫檢體送驗單'],
  },
  {
    id: 'measles-definition',
    user: 'staff7',
    q: '麻疹通報定義',
    expect: ['麻疹通報定義', '24小時', 'CDC 病例定義連結', 'https://www.cdc.gov.tw/File/Get/'],
    forbid: ['外籍病人、旅客', '資料來源', 'ANN00046'],
  },
  {
    id: 'audit-mode-definition-stays-concise',
    user: 'audit-definition',
    sequence: ['評鑑查核', '瘧疾通報定義'],
    expect: ['瘧疾通報定義查詢重點', '24小時', 'CDCN0119'],
    forbid: ['詳細臨床條件請以疾管署連結為準', '院內端同步確認', '查核視角提醒'],
    quick: ['通報重點', '採檢佐證', '委員提問', 'KM佐證'],
    quickNot: ['隔離醫囑', '病人安置', 'PPE防護', '清消', '解隔標準'],
  },
  {
    id: 'audit-mode-broad-disease-gives-evidence-location',
    user: 'audit-measles',
    sequence: ['評鑑查核', '麻疹'],
    expect: ['麻疹對應查核面向', '通報、隔離標示、PPE、病人安置、採檢送驗、環境清消及相關紀錄', '請點選下方想查詢的面向'],
    forbid: ['可以查的範圍很多', '查核視角提醒', 'Y:\\IFC_V', '對應條文', '4.1 主條文'],
    quick: ['通報與時限', '隔離標示', 'PPE防護', '病人安置', '採檢送驗', '環境清消', '相關紀錄'],
    quickNot: ['委員提問', 'KM佐證', '執行紀錄', '處置重點'],
  },
  {
    id: 'audit-influenza-specific-questions',
    user: 'audit-influenza-questions',
    sequence: ['評鑑查核', '流感評鑑委員可能提問'],
    expect: ['流感評鑑委員可能提問與現場答案', '第四類法傳流感重症', 'ANN00039', '外科口罩', '如何證明流程確實完成'],
    forbid: ['文件、佐證與現場作答', '第一線如何辨識、啟動流程、留下紀錄', '。；'],
    quick: ['通報與時限', '隔離標示', 'PPE防護', '病人安置', '採檢送驗', '環境清消', '相關紀錄'],
  },
  {
    id: 'audit-influenza-specific-evidence',
    user: 'audit-influenza-evidence',
    sequence: ['評鑑查核', '流感KM佐證'],
    expect: ['流感評鑑查核 KM 佐證與勾稽紀錄', '流感感染管制措施', 'ANN00039', '鼻咽拭子', '檢驗結果', '清消紀錄', '委員勾稽方式'],
    forbid: ['文件、佐證與現場作答', '依查核主題至 KM', '。；'],
    quick: ['通報與時限', '隔離標示', 'PPE防護', '病人安置', '採檢送驗', '環境清消', '相關紀錄'],
  },
  {
    id: 'audit-influenza-facet-selection',
    user: 'audit-influenza-facet-selection',
    sequence: ['評鑑查核', '流感病人安置查核'],
    expect: ['流感病人安置查核', '飛沫隔離', '單人病室或同類集中照護', '床位安排'],
    quick: ['通報與時限', '隔離標示', 'PPE防護', '採檢送驗', '環境清消', '相關紀錄'],
    quickNot: ['病人安置'],
  },
  {
    id: 'audit-cjd-summarizes-before-km-location',
    user: 'audit-cjd',
    sequence: ['評鑑查核', '庫賈氏病'],
    expect: ['庫賈氏病評鑑查核重點', 'CJD 風險辨識', 'KM 可查閱佐證', '現場／系統執行紀錄', 'CJD 勾稽紀錄', 'KM 位置', '50300-3-000013', '庫賈氏病感染管制措施'],
    forbid: ['Y:\\IFC_V', '115年感管查核全院宣導檔案', '對應條文', '4.1 主條文'],
    quick: ['院內勾稽紀錄', '手動勾稽', '風險判定', '器械處理', 'KM佐證'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置', '採檢送驗'],
  },
  {
    id: 'audit-cjd-reconciliation-method',
    user: 'audit-cjd-method',
    sequence: ['評鑑查核', 'CJD 院內系統勾稽紀錄怎麼查'],
    expect: ['CJD', 'portal', '排程畫面', '列管中', 'API 歷程', 'documentId=157420'],
    forbid: ['目前未檢索到', '通報定義', '隔壁床'],
  },
  {
    id: 'clinical-cjd-reconciliation-method-direct',
    user: 'clinical-cjd-method',
    q: 'CJD 院內系統勾稽紀錄怎麼查',
    expect: ['CJD 院內系統勾稽紀錄查詢', 'portal', '排程畫面', '列管中', 'API 歷程', 'documentId=157420', '如與正式公告不一致，以正式公告為準。'],
    forbid: ['目前未檢索到', '關鍵字檢索命中度較低', '感染管制小幫手', '一般流程摘要｜'],
    quick: ['手動勾稽', '風險判定', '器械處理', 'KM佐證'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置'],
  },
  {
    id: 'clinical-cjd-manual-reconciliation-direct',
    user: 'clinical-cjd-manual-direct',
    q: 'CJD 疾管署手動勾稽怎麼查',
    expect: ['CJD 疾管署手動勾稽', '臨時排程', '單卡讀卡機', '0401180014', '儲存', '本院資料庫'],
    forbid: ['感染管制處置與規範重點整理', '庫賈氏病可以查的範圍很多', 'prion'],
    quick: ['院內勾稽紀錄', '風險判定', '器械處理', 'KM佐證'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置'],
  },
  {
    id: 'clinical-cjd-nasal-surgery-direct',
    user: 'clinical-cjd-nasal-surgery-direct',
    q: 'CJD 病人要做鼻腔手術怎麼辦',
    expect: ['CJD 病人接受鼻腔手術', '院內 CJD 勾稽歷程', '中或高感染力組織', '手術室', '供應室', '感染管制中心', '器械須與低感染力器械分流'],
    forbid: ['感染管制處置與規範重點整理', '庫賈氏病可以查的範圍很多', '通報定義'],
    quick: ['院內勾稽紀錄', '手動勾稽', '器械處理', 'KM佐證'],
    quickNot: ['隔離醫囑', '病人安置', '採檢送驗'],
  },
  {
    id: 'audit-needlestick-contextual-routing',
    user: 'audit-needlestick-context',
    sequence: ['評鑑查核', '針扎'],
    expect: ['尖銳物品扎傷', '對應查核面向', 'KM佐證'],
    forbid: ['一般流程摘要｜'],
    quick: ['立即處理', 'HIV PEP', '檢驗追蹤', '委員提問', 'KM佐證'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置', '採檢送驗', 'PPE防護', '清消', '解隔標準'],
  },
  {
    id: 'audit-cjd-manual-reconciliation',
    user: 'audit-cjd-manual',
    sequence: ['評鑑查核', 'CJD 疾管署手動勾稽怎麼查'],
    expect: ['臨時排程', '醫事人員卡', '單卡讀卡機', '0401180014', '儲存', '本院資料庫'],
    forbid: ['目前未檢索到', '通報定義', '隔壁床'],
  },
  {
    id: 'measles-exposure',
    user: 'staff8',
    q: '麻疹暴露',
    expect: ['出疹前 4 天', '出疹後 4 天', 'MMR'],
    quickNot: ['暴露處置'],
  },
  {
    id: 'country-epidemic',
    user: 'staff9',
    q: '奈及利亞有何特殊傳染病',
    expect: ['奈及利亞'],
    forbid: ['門診特殊傳染性疾病病人', '醫師人力動員'],
  },
  {
    id: 'endoscopy',
    user: 'staff10',
    q: '內視鏡',
    expect: ['內視鏡再處理流程重點', '前置清洗', '測漏', '高層次消毒', 'KM：50300-2-000010'],
    forbid: ['庫賈氏病', 'CJD', '鼻腔手術'],
    quick: ['評鑑查核', '臨床照護', '疫情訊息'],
  },
  {
    id: 'language',
    user: 'staff11',
    q: 'What is Ebola isolation?',
    expect: ['偵測到您可能使用 English'],
    quick: ['繁體中文', 'English', 'Bahasa', 'Tiếng Việt'],
  },
  {
    id: 'ebola-common-typo',
    user: 'ebola-typo',
    q: '伊坡拉',
    expect: ['伊波拉'],
    forbid: ['關鍵字檢索命中度較低', '未檢索到完全相符'],
  },
  {
    id: 'measles-common-typo-with-intent',
    user: 'measles-typo',
    q: '麻診通報定義',
    expect: ['麻疹通報定義查詢重點'],
    forbid: ['未檢索到完全相符'],
  },
  {
    id: 'dengue-common-typo-deng-ge',
    user: 'dengue-typo-ge',
    q: '登隔熱',
    expect: ['登革熱'],
    forbid: ['未檢索到完全相符', '關鍵字檢索命中度較低'],
  },
  {
    id: 'english-disease-near-match',
    user: 'malaria-english-typo',
    q: 'malarai通報定義',
    expect: ['瘧疾通報定義查詢重點'],
    forbid: ['未檢索到完全相符'],
  },
  {
    id: 'language-id-followup',
    user: 'staff11id',
    sequence: ['Bahasa Indonesia', 'VRE隔離'],
    expect: ['TERJEMAHAN ID:', 'VRE'],
    quick: ['評鑑查核', '臨床照護', '疫情訊息'],
  },
  {
    id: 'language-vi-followup',
    user: 'staff11vi',
    sequence: ['Tiếng Việt', '登革熱隔離醫囑'],
    expect: ['BAN DICH VI:', 'ANN00049'],
    quick: ['評鑑查核', '臨床照護', '疫情訊息'],
  },
  {
    id: 'smalltalk',
    user: 'staff12',
    q: '你真好',
    expect: ['謝謝您'],
    quick: ['可以查什麼', 'VRE解隔'],
  },
  {
    id: 'mood-support-phrases',
    user: 'mood-support',
    sequence: ['心情低落', '哭泣', '哭哭'],
    expect: ['辛苦了', '可信任的人'],
    forbid: ['未檢索到完全相符', '感染管制小幫手'],
  },
  {
    id: 'self-harm-still-has-priority',
    user: 'mood-safety-priority',
    q: '心情低落到不想活',
    expect: ['請先不要一個人承受', '1925'],
    forbid: ['未檢索到完全相符'],
  },
  {
    id: 'help-current-running-work-phrasing',
    user: 'help-running-work',
    q: '你現在有什麼在執行的事',
    expect: ['可查感染管制', '法定傳染病通報', '議題曾在哪些日期出現'],
    forbid: ['關鍵字檢索命中度較低', '可能相關主題'],
  },
  {
    id: 'public-meeting-hidden',
    user: 'public1',
    identity: 'public',
    q: '你好',
    quickNot: ['會議檢索'],
  },
  {
    id: 'staff-meeting-visible',
    user: 'staff13',
    q: '你好',
    quick: ['會議檢索', '🔒滿意度'],
    quickNot: ['滿意度'],
    quickTail: ['疫情訊息', '評鑑查核', '臨床照護', '🔒滿意度', '感管意見箱'],
  },
  {
    id: 'manual-satisfaction-blocked-before-five',
    user: 'satisfaction-manual',
    q: '🔒滿意度',
    expect: ['完成 5 次有效問答後', '目前已完成 0/5 次'],
    quick: ['🔒滿意度'],
    quickNot: ['滿意度', '非常有幫助', '沒有幫助'],
  },
  {
    id: 'automatic-satisfaction-after-five-answers',
    user: 'satisfaction-auto',
    sequence: ['VRE隔離', '麻疹通報定義', '登革熱隔離', '水痘解隔', '日腦採檢'],
    expect: ['滿意度調查｜非醫療處置選項', '不是病人處置選項'],
    quick: ['非常有幫助', '沒有幫助'],
  },
  {
    id: 'satisfaction-score-two-is-explicit',
    user: 'satisfaction-score-two',
    sequence: ['VRE隔離', '麻疹通報定義', '登革熱隔離', '水痘解隔', '日腦採檢', '2'],
    expect: ['已記錄「滿意度 2 分：有幫助」'],
    forbid: ['目前未檢索到完全相符'],
  },
  {
    id: 'meeting-dates-only',
    user: 'staff-meeting-query',
    q: 'VRE在哪些週會出現',
    expect: ['2026-08-01', '2026-08-08'],
    forbid: ['測試摘要不得回傳', '另一段會議內容不得回傳', '週會紀錄_檢索記事本', '檔案：'],
  },
  {
    id: 'meeting-button-asks-for-topic',
    user: 'staff-meeting-guide',
    q: '會議檢索',
    expect: ['請輸入想查的議題', '只會顯示出現日期'],
    forbid: ['目前在週會/月會檢索檔沒有找到', '查得日期'],
  },
  {
    id: 'meeting-keeps-full-infection-report-topic',
    user: 'staff-meeting-monthly-report',
    q: '感染月報在哪些週會出現',
    expect: ['2026-08-15'],
    forbid: ['沒有找到', '月報摘要不得回傳', '檔案：'],
  },
  {
    id: 'meeting-not-triggered-without-explicit-query',
    user: 'staff-meeting-nonquery',
    q: 'VRE處置',
    forbid: ['2026-08-01', '2026-08-08', '查得日期'],
  },
  {
    id: 'suggestion-records-never-readable-from-line',
    user: 'suggestion-reader',
    q: '查意見箱',
    expect: ['僅供投稿', '不會透過 LINE 對話提供'],
    forbid: ['這是不可由 LINE 讀取的測試意見內容', '最近收到的感管意見'],
  },
  {
    id: 'a-flu',
    user: 'staff14',
    q: 'A流隔離',
    expect: ['流感', 'ANN00039'],
    forbid: ['偵測到您可能使用', '新型A型流感', '第五類'],
  },
  {
    id: 'b-flu-short-alias',
    user: 'staff14d',
    q: 'B流',
    expect: ['流感可以查的範圍很多'],
    forbid: ['全傳染病台大感管線上互動', 'GitHub Pages', '漂白水清消線上計算器', '新型A型流感', '第五類'],
    quick: ['通報定義', '隔離醫囑', '病人安置', '採檢送驗'],
  },
  {
    id: 'b-flu-isolation',
    user: 'staff14e',
    q: 'B流隔離',
    expect: ['流感', 'ANN00039'],
    forbid: ['全傳染病台大感管線上互動', 'GitHub Pages', '新型A型流感', '第五類'],
  },
  {
    id: 'novel-a-flu-definition',
    user: 'staff14b',
    q: '新型A型流感通報定義',
    expect: ['新型A型流感', '第五類', 'CDC 病例定義連結'],
    forbid: ['ANN00039', '季節流感'],
  },
  {
    id: 'h5n1-epidemic',
    user: 'staff14c',
    q: 'H5N1疫區',
    expect: ['新型A型流感'],
    forbid: ['流感 隔離醫囑'],
  },
  {
    id: 'synonym-c-hepatitis',
    user: 'staff15',
    q: 'C肝通報定義',
    expect: ['急性病毒性C型肝炎', 'CDC 病例定義連結'],
    forbid: ['目前未檢索到完全相符', '同義字', '已外部化'],
  },
  {
    id: 'synonym-unspecified-hepatitis-definition',
    user: 'staff15b',
    q: '未定型肝炎通報定義',
    expect: ['急性病毒性肝炎未定型', '第三類', '一週內通報', 'CDC 病例定義連結', 'VI0ZW7okpJgReFZza2yPgg'],
    forbid: ['外籍病人、旅客', '擔心航班', '不是處罰', '目前未檢索到完全相符'],
  },
  {
    id: 'synonym-je',
    user: 'staff16',
    q: '日腦採檢',
    expect: ['日本腦炎', '院內檢驗醫令/檢體'],
    forbid: ['目前未檢索到完全相符', '同義字', '已外部化'],
  },
  {
    id: 'synonym-meningococcal',
    user: 'staff17',
    q: '流腦採檢',
    expect: ['流行性腦脊髓膜炎', '院內檢驗醫令/檢體'],
    forbid: ['目前未檢索到完全相符', '同義字', '已外部化'],
  },
  {
    id: 'varicella-clearance',
    user: 'staff18',
    q: '水痘解隔',
    expect: ['水痘', '空氣＋接觸隔離', '所有水泡病灶乾燥結痂', '不要求常規檢驗陰性', 'ANN10042', 'ANN00042'],
    forbid: ['目前未檢索到完全相符', '同義字', '已外部化'],
  },
  {
    id: 'varicella-sanitization-specific',
    user: 'varicella-sanitization',
    q: '水痘清消',
    expect: ['水痘 環境清消與終末消毒重點', '0.05%～0.06%', '500～600 ppm', '高頻表面', '病人用品儘量專用', '負壓病室換氣規範', '終期清潔'],
    forbid: ['透析室', '血液透析', '洗腎室', 'COVID-19', '嗅味覺喪失', '人工腎臟'],
  },
  {
    id: 'unprofiled-disease-sanitization-never-leaks-dialysis',
    user: 'cholera-sanitization',
    q: '霍亂清消',
    expect: ['霍亂環境清消重點', '未見此疾病的專屬消毒濃度', '不引用其他疾病或特殊單位', '先清除可見髒污', '終期清潔'],
    forbid: ['疑似或確診 COVID-19', '至少 2 公尺', '血液透析設備', '人工腎臟', '止血鉗'],
  },
  {
    id: 'localized-zoster-clearance',
    user: 'zoster-clearance',
    q: '帶狀疱疹解隔標準',
    expect: ['帶狀疱疹解除隔離重點', '侷限性且免疫功能正常', '病灶應完整覆蓋', '瀰漫性帶狀疱疹', '空氣＋接觸隔離', 'ANN10042'],
    forbid: ['水痘解除隔離重點', '解隔標準需依疾病別規範判斷'],
  },
  {
    id: 'disseminated-zoster-definition',
    user: 'disseminated-zoster-definition',
    q: '瀰漫性帶狀皰疹的定義',
    expect: ['瀰漫性帶狀疱疹定義', '院內定義', '侵犯 3 個神經節（含）以上', '空氣＋接觸隔離'],
    forbid: ['20 顆', '皮節以外', '水痘通報定義', '目前在本地知識庫沒有完整條件'],
  },
  {
    id: 'endoscope-contextual-quick-replies',
    user: 'endoscope-quick',
    q: '內視鏡',
    expect: ['內視鏡'],
    quick: ['再處理流程', '手工清洗', '高層次消毒', '乾燥與儲存', '異常監測'],
    forbidQuick: ['麻疹暴露', '百日咳採檢', 'VRE隔離', '登革熱通報'],
  },
  {
    id: 'endoscope-manual-cleaning-backed',
    user: 'endoscope-manual-cleaning',
    q: '內視鏡手工清洗',
    expect: ['管路刷至少通過 3 次', '清洗不完整時不可直接以消毒取代', 'KM：50300-2-000010'],
    forbid: ['庫賈氏病', 'CJD'],
  },
  {
    id: 'endoscope-high-level-disinfection-backed',
    user: 'endoscope-hld',
    q: '內視鏡高層次消毒',
    expect: ['自動化內視鏡再處理機', '測漏', '消毒劑濃度、溫度與接觸時間', 'KM：50300-2-000010'],
    forbid: ['庫賈氏病', 'CJD'],
  },
  {
    id: 'endoscope-drying-storage-backed',
    user: 'endoscope-storage',
    q: '內視鏡乾燥與儲存',
    expect: ['Alcohol flush', '手動乾燥 10 分鐘', '超過 7 日', '超過 3 日', 'KM：50300-2-000010'],
    forbid: ['庫賈氏病', 'CJD'],
  },
  {
    id: 'endoscope-monitoring-abnormal-backed',
    user: 'endoscope-monitoring',
    q: '內視鏡微生物監測異常',
    expect: ['暫停使用', '雙重高層次消毒或滅菌', '複檢合格', 'KM：50300-2-000010'],
    forbid: ['鼻腔手術'],
  },
  {
    id: 'audit-mode-education-routes-to-clause-evidence',
    user: 'audit-education',
    sequence: ['評鑑查核', '教育'],
    expect: ['查核條文 1.3', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄'],
    forbid: ['疫災應變人員教育訓練行動計畫', '計畫部感染分析及應變小組'],
    quick: ['條文重點', '委員提問', 'KM佐證', '執行紀錄'],
  },
  {
    id: 'audit-mode-vaccine-policy-routes-to-clause-evidence',
    user: 'audit-vaccine',
    sequence: ['評鑑查核', '疫苗政策'],
    expect: ['查核條文 5.1', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄'],
    forbid: ['關鍵字檢索命中度較低', '民眾版', '出國旅遊的疫苗'],
    quick: ['條文重點', '委員提問', 'KM佐證', '執行紀錄'],
  },
  {
    id: 'audit-broad-antibiotic-menu',
    user: 'audit-antibiotic-menu',
    sequence: ['評鑑查核', '抗生素管制'],
    expect: ['抗生素管理涉及三項查核條文', '計畫與權責', '使用監測', '抗藥性防治'],
    forbid: ['關鍵字檢索命中度較低', '抗微生物製劑管理查核重點'],
    quick: ['計畫與權責', '使用監測', '抗藥性防治', '手術預防用藥'],
  },
  {
    id: 'audit-broad-epidemic-policy-menu',
    user: 'audit-epidemic-menu',
    sequence: ['評鑑查核', '防疫政策'],
    expect: ['防疫政策涉及數項查核條文', '手冊與疫情資訊', '隔離與應變', '傳染病通報', '防疫物資', '員工保護'],
    forbid: ['疫災應變整體人力備援計畫', '臨床醫療工作人員應掌握'],
    quick: ['手冊與疫情', '隔離與應變', '傳染病通報', '防疫物資', '員工保護'],
  },
  {
    id: 'audit-broad-epidemic-short-menu',
    user: 'audit-epidemic-short-menu',
    sequence: ['評鑑查核', '防疫'],
    expect: ['防疫政策涉及數項查核條文', '手冊與疫情資訊', '隔離與應變', '傳染病通報', '防疫物資', '員工保護'],
    forbid: ['員工關懷防疫門診', 'BB lotion', '傳染病防治專款', '在病房電腦操作門診系統', '感染管制處置與規範重點整理'],
    quick: ['手冊與疫情', '隔離與應變', '傳染病通報', '防疫物資', '員工保護'],
  },
  {
    id: 'audit-broad-notifiable-reporting-routes-to-4-1',
    user: 'audit-notifiable-reporting',
    sequence: ['評鑑查核', '傳染病通報'],
    expect: ['查核條文 4.1', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄'],
    forbid: ['外籍人士', '即將出境', '航班', '簽證', '不是處罰病人', '感染管制處置與規範重點整理'],
    quick: ['條文重點', '委員提問', 'KM佐證', '執行紀錄'],
  },
  {
    id: 'audit-infection-rate-monitoring-routes-to-1-6',
    user: 'audit-infection-rate-monitoring',
    sequence: ['評鑑查核', '感染率監測'],
    expect: ['查核條文 1.6', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄'],
    forbid: ['感染率監測查核重點', '感染風險為何？數據如何回饋？改善後如何確認有效', '通報定義', '隔離醫囑', '病人安置', '採檢送驗', 'PPE防護', '解隔標準'],
    quick: ['條文重點', '委員提問', 'KM佐證', '執行紀錄'],
    quickNot: ['通報定義', '隔離醫囑', '病人安置', '採檢送驗', 'PPE防護', '清消', '解隔標準'],
  },
  {
    id: 'clinical-broad-notifiable-reporting-asks-for-disease',
    user: 'clinical-notifiable-reporting',
    sequence: ['臨床照護', '傳染病通報'],
    expect: ['疾病名稱＋查詢項目', '通報定義與時限', '採檢送驗', '隔離與院內處置'],
    forbid: ['外籍人士', '即將出境', '航班', '簽證', '不是處罰病人', '感染管制處置與規範重點整理'],
    quick: ['麻疹通報', '登革熱通報', '結核病通報', '採檢送驗'],
  },
  {
    id: 'audit-clause-question-detail',
    user: 'audit-clause-question',
    sequence: ['評鑑查核', '查核條文 5.1 委員提問'],
    expect: ['查核條文 5.1', '委員可能的提問與回答方向', '哪些人納入員工保護', '疫苗如何管理', '員工出現症狀如何處理', '胸部 X 光如何落實', '發生傳染病暴露怎麼辦', '建議先備妥的 KM 佐證'],
    forbid: ['關鍵字檢索命中度較低'],
    quick: ['條文重點', 'KM佐證', '執行紀錄'],
    quickNot: ['委員提問'],
  },
  {
    id: 'audit-clause-km-evidence-detail',
    user: 'audit-clause-km',
    sequence: ['評鑑查核', '查核條文 5.1 KM佐證'],
    expect: ['查核條文 5.1', 'KM佐證', '【預防接種】', '員工預防接種措施', '【健康監測】', '健康監測通報規範', '【胸部 X 光與暴露處置】', '員工胸部 X 光檢查計畫', '員工暴露傳染性疾病調查'],
    forbid: ['Y:\\IFC_V', '關鍵字檢索命中度較低'],
    quick: ['條文重點', '委員提問', '執行紀錄'],
    quickNot: ['KM佐證'],
  },
  {
    id: 'influenza-clearance-specific',
    user: 'influenza-clearance',
    q: '流感解隔標準',
    expect: ['流感解除隔離重點', '不建議只用固定天數', '不要求一律驗到陰性', '是否退燒', '呼吸道分泌物', '氣膠處置', '免疫功能低下', 'ANN10039', 'ANN00039'],
    forbid: ['流感解隔標準需依疾病別規範判斷', '若要精準判斷', '請改問'],
  },
  {
    id: 'influenza-clearance-suggested-phrases-pasted-together',
    user: 'influenza-clearance-pasted',
    q: '「流感 解隔天數」、「流感 是否要陰性」、「流感 取消隔離醫囑」',
    expect: ['流感解除隔離重點', '不建議只用固定天數', '不要求一律驗到陰性', 'ANN10039', 'ANN00039'],
    forbid: ['流感解隔標準需依疾病別規範判斷', '若要精準判斷', '請改問'],
  },
  {
    id: 'clarify-disease-only',
    user: 'staff19',
    q: '兔熱病',
    expect: ['兔熱病可以查的範圍很多', '請點下方快捷鈕'],
    forbid: ['SOP 總覽', 'CDCN0045'],
    quick: ['通報定義', '採檢送驗', '隔離醫囑'],
  },
  {
    id: 'clarify-broad-infection-control',
    user: 'staff20',
    q: '登革熱感染管制',
    expect: ['登革熱可以查的範圍很多', '登革熱通報定義', '登革熱隔離醫囑'],
    forbid: ['ANN00049 防蚊隔離', 'SOP 總覽'],
    quick: ['通報定義', '病人安置', '採檢送驗'],
  },
  {
    id: 'clarify-subtopic-only',
    user: 'staff21',
    q: '解隔標準',
    expect: ['請問您要查哪一種疾病或菌株的解隔標準'],
    forbid: ['解除接觸隔離共同基本條件', 'VRE 通常需先確認'],
    quick: ['VRE解隔', 'CRE解隔', '流感解隔', '水痘解隔'],
  },
  {
    id: 'carryover-subtopic-after-disease',
    user: 'staff22',
    sequence: ['VRE隔離', '解隔標準'],
    expect: ['VRE解除接觸隔離重點', '肛門'],
    forbid: ['請問您要查哪一種疾病或菌株'],
  },
];

const officialAuditClauses = JSON.parse(auditText).clauses || [];
const globalDiseaseMatrix = [
  'VRE', 'CRE', 'MRSE', 'MRSA', 'CRAB', 'CRPA', '耳念珠菌', 'MDRO',
  '兔熱病', '黃熱病', 'Q熱', '日本腦炎', '德國麻疹', '麻疹', '流行性腮腺炎', '百日咳', '登革熱',
  '新型A型流感', '流感', '新冠', '帶狀疱疹', '水痘', '結核', 'C. difficile', '庫賈氏病', '伊波拉',
  '腸病毒', '疥瘡', '瘧疾', '狂犬病', '破傷風', '白喉', '屈公病', '茲卡', '傷寒', '副傷寒',
  '斑疹傷寒', '桿菌性痢疾', '阿米巴痢疾', '霍亂', '流行性腦脊髓膜炎', '侵襲性b型嗜血桿菌感染症',
  '侵襲性肺炎鏈球菌感染症', '炭疽', '鼠疫', '天花', '類鼻疽', '鉤端螺旋體', '立百病毒', '馬堡病毒',
  '拉薩熱', '漢他病毒', '退伍軍人病', 'M痘', '發熱伴血小板減少綜合症', '急性A型肝炎', '急性B型肝炎',
  '急性病毒性C型肝炎', '急性E型肝炎', '急性病毒性肝炎未定型', '梅毒', '淋病', '恙蟲病', '萊姆病', 'HIV'
];
const globalDiseaseSubtopics = ['通報定義', '隔離醫囑', '病人安置', '採檢送驗', 'PPE', '清消', '解隔標準'];
globalDiseaseMatrix.forEach((diseaseName, diseaseIndex) => {
  globalDiseaseSubtopics.forEach((subtopic, subtopicIndex) => {
    cases.push({
      id: 'global-disease-matrix-' + diseaseIndex + '-' + subtopicIndex,
      user: 'global-disease-' + diseaseIndex + '-' + subtopicIndex,
      q: diseaseName + subtopic,
      expect: [diseaseName],
      forbid: [
        '目前未檢索到完全相符的規範', '關鍵字檢索命中度較低', '隔壁床住了隔離病人',
        '透析室、血液透析室或洗腎室', '需依疾病別規範判斷', '若要精準判斷',
        '回答重點', '查核佐證路徑與用途', 'Y:\\'
      ].concat(subtopicIndex === 6 ? [
        '目前知識庫未載明', '不提供推測', '需依疾病別規範判斷'
      ] : [])
    });
  });
  const isMdroAuditClause = ['VRE', 'CRE', 'MRSA', 'CRAB', 'CRPA', 'MDRO'].includes(diseaseName);
  cases.push({
    id: 'global-audit-disease-' + diseaseIndex,
    user: 'global-audit-disease-' + diseaseIndex,
    sequence: ['評鑑查核', diseaseName],
    expect: isMdroAuditClause
      ? ['查核條文 3.3', '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄']
      : diseaseName === '庫賈氏病'
        ? [diseaseName, '評鑑查核重點', '委員可能詢問', 'KM']
        : [diseaseName + '對應查核面向', '通報、隔離標示、PPE、病人安置、採檢送驗、環境清消及相關紀錄'],
    forbid: ['目前未檢索到完全相符的規範', '關鍵字檢索命中度較低', '隔壁床住了隔離病人', 'Y:\\'],
    quick: diseaseName === '庫賈氏病'
      ? ['院內勾稽紀錄', '手動勾稽']
      : isMdroAuditClause
        ? ['條文重點', '委員提問', 'KM佐證', '執行紀錄']
        : ['通報與時限', '隔離標示', 'PPE防護', '病人安置', '採檢送驗', '環境清消', '相關紀錄'],
    quickNot: diseaseName === '庫賈氏病' || isMdroAuditClause
      ? ['通報定義', '隔離醫囑', '病人安置', '採檢送驗']
      : ['委員提問', 'KM佐證', '執行紀錄', '處置重點']
  });
});
officialAuditClauses.forEach((clause, index) => {
  const clauseMenuQuickReplies = ['條文重點', '委員提問', 'KM佐證', '執行紀錄'];
  const firstKmEvidence = clause.id === '5.1'
    ? { name: '員工預防接種措施', url: 'https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=54430' }
    : clause.id === '1.6'
      ? { name: 'THAS醫療照護相關感染通報統計表', url: 'https://km.ntuh.gov.tw/km/listfolders.aspx?uid=22728' }
    : clause.id === '4.1'
      ? { name: '傳染病監視通報機制', url: 'https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=87870' }
    : ((clause.evidence || []).find((item) => /^https:\/\/km\.ntuh\.gov\.tw\//.test(String(item.url || ''))) || {});
  const defaultClauseExpect = [clause.title, '查核條文 ' + clause.id, '對應查核面向', '條文重點、委員提問、KM佐證及執行紀錄', '請點選下方想查詢的面向'];
  const questionClauseExpect = clause.id === '1.6'
    ? ['感染率監測與改善', '查核條文 1.6', '委員可能的提問與回答方向', '監測哪些感染', '改善是否有效', '建議先備妥的 KM 佐證', 'THAS統計']
    : [clause.title, '查核條文 ' + clause.id, '委員可能的提問', '回答方向', '建議先備妥的 KM 佐證', firstKmEvidence.name];
  const kmClauseExpect = clause.id === '1.6'
    ? ['感染率監測與改善', '查核條文 1.6', 'KM佐證', '【監測資料】', '【會議檢討】', '【改善與成效】', firstKmEvidence.name, firstKmEvidence.url]
    : [clause.title, '查核條文 ' + clause.id, 'KM佐證', firstKmEvidence.name, firstKmEvidence.url];
  cases.push({
    id: 'audit-clause-number-coverage-' + clause.id,
    user: 'audit-clause-number-' + index,
    sequence: ['評鑑查核', '查核條文 ' + clause.id],
    expect: defaultClauseExpect,
    forbid: ['關鍵字檢索命中度較低', '可能相關主題'],
    quick: clauseMenuQuickReplies,
  });
  cases.push({
    id: 'audit-clause-question-view-' + clause.id,
    user: 'audit-clause-question-view-' + index,
    sequence: ['評鑑查核', '查核條文 ' + clause.id + ' 委員提問'],
    expect: questionClauseExpect,
    forbid: ['關鍵字檢索命中度較低', '可能相關主題', '查核佐證路徑與用途', '以下路徑只在', 'Y:\\'],
    quick: ['條文重點', 'KM佐證', '執行紀錄'],
    quickNot: ['委員提問'],
  });
  cases.push({
    id: 'audit-clause-km-view-' + clause.id,
    user: 'audit-clause-km-view-' + index,
    sequence: ['評鑑查核', '查核條文 ' + clause.id + ' KM佐證'],
    expect: kmClauseExpect,
    forbid: ['關鍵字檢索命中度較低', '可能相關主題', '查核佐證路徑與用途', '以下路徑只在', 'Y:\\'],
    quick: ['條文重點', '委員提問', '執行紀錄'],
    quickNot: ['KM佐證'],
  });
  (clause.aliases || []).forEach((alias, aliasIndex) => {
    if (['抗生素管制', '抗生素管理', '抗菌藥物管理', '抗微生物製劑管理'].includes(alias)) return;
    cases.push({
      id: 'audit-clause-alias-coverage-' + clause.id + '-' + (aliasIndex + 1),
      user: 'audit-clause-alias-' + index + '-' + aliasIndex,
      sequence: ['評鑑查核', alias],
      expect: defaultClauseExpect,
      forbid: ['關鍵字檢索命中度較低', '可能相關主題'],
      quick: clause.id === '5.2' && /針扎|尖銳物|血液體液暴露|職業暴露|HIV\s*PEP/i.test(alias)
        ? ['立即處理', 'HIV PEP', '檢驗追蹤', '委員提問', 'KM佐證']
        : clauseMenuQuickReplies,
    });
  });
});

cases.push({
  id: 'audit-clause-records-view-5.1',
  user: 'audit-clause-records-view-5-1',
  sequence: ['評鑑查核', '查核條文 5.1 執行紀錄'],
  expect: ['查核條文 5.1', '執行紀錄', '執行時間', '負責人', '異常處理', '改善措施', '追蹤結果'],
  quick: ['條文重點', '委員提問', 'KM佐證'],
  quickNot: ['執行紀錄'],
});

let failures = 0;
const outputs = [];

for (const testCase of cases) {
  resetUser(testCase.user, testCase.identity || 'staff');
  let result;
  if (testCase.followWelcome) {
    const event = { source: { userId: testCase.user } };
    const answer = ctx.finalizeAnswer_({
      text: ctx.followWelcomeReply_(),
      diseaseName: '閒聊',
    }, event, '', '', { skipCount: true });
    const qr = ctx.buildQuickReplyForDisease_(answer.diseaseName, answer);
    result = {
      question: '[follow event]',
      diseaseName: answer.diseaseName || '',
      sentText: String(ctx.sanitizeLineText_(answer.text) || ''),
      quickReplyLabels: qr && qr.items ? qr.items.map((item) => item.action && item.action.label).filter(Boolean) : [],
    };
  } else if (testCase.sequence) {
    for (const q of testCase.sequence) result = ask(testCase.user, q);
    result.question = testCase.sequence.join(' -> ');
  } else {
    result = ask(testCase.user, testCase.q);
  }
  const missing = includesAll(result.sentText, testCase.expect || []);
  const forbidden = excludesAll(result.sentText, (testCase.forbid || []).concat(['**', '`', '###']));
  const missingQuick = (testCase.quick || []).filter((label) => !result.quickReplyLabels.includes(label));
  const forbiddenQuick = (testCase.quickNot || []).filter((label) => result.quickReplyLabels.includes(label));
  const expectedTail = testCase.quickTail || [];
  const actualTail = expectedTail.length ? result.quickReplyLabels.slice(-expectedTail.length) : [];
  const wrongQuickTail = expectedTail.length && JSON.stringify(actualTail) !== JSON.stringify(expectedTail)
    ? { expected: expectedTail, actual: actualTail }
    : null;
  const ok = !missing.length && !forbidden.length && !missingQuick.length && !forbiddenQuick.length && !wrongQuickTail;
  if (!ok) failures += 1;
  outputs.push({
    id: testCase.id,
    ok,
    question: result.question,
    diseaseName: result.diseaseName,
    missing,
    forbidden,
    missingQuick,
    forbiddenQuick,
    wrongQuickTail,
    quickReplyLabels: result.quickReplyLabels,
    preview: result.sentText.replace(/\n/g, ' ').slice(0, 260),
  });
}

const genericClinicalAuditLabels = ['通報定義', '隔離醫囑', '清消', '解隔標準'];
const auditQuickReplyViolations = outputs.filter((item) => {
  if (!String(item.question || '').startsWith('評鑑查核 ->')) return false;
  return (item.quickReplyLabels || []).some((label) => genericClinicalAuditLabels.includes(label));
});
const auditQuickReplyCoverageOk = auditQuickReplyViolations.length === 0;
if (!auditQuickReplyCoverageOk) failures += 1;
outputs.push({
  id: 'all-audit-topics-use-contextual-quick-replies',
  ok: auditQuickReplyCoverageOk,
  question: '[all audit topic quick replies]',
  diseaseName: '評鑑查核',
  missing: [],
  forbidden: auditQuickReplyViolations.map((item) => item.id),
  missingQuick: [],
  forbiddenQuick: [],
  wrongQuickTail: null,
  quickReplyLabels: [],
  preview: auditQuickReplyCoverageOk ? 'All audit topics use contextual quick replies.' : auditQuickReplyViolations.map((item) => item.id).join(', '),
});

const textOnlyReplyOk = /messages:\s*\[messageObj\]/.test(code) && !/type:\s*['"]image['"]/.test(code);
if (!textOnlyReplyOk) failures += 1;
outputs.push({
  id: 'line-reply-is-text-only',
  ok: textOnlyReplyOk,
  question: '[LINE reply payload]',
  diseaseName: '',
  missing: textOnlyReplyOk ? [] : ['single text message payload'],
  forbidden: textOnlyReplyOk ? [] : ['image message'],
  missingQuick: [],
  forbiddenQuick: [],
  wrongQuickTail: null,
  quickReplyLabels: [],
  preview: textOnlyReplyOk ? 'All LINE replies send one text message only.' : 'Image routing remains in Code.gs.',
});

const internalPathSample = [
  '查核資料：',
  '查核作業手冊：Y:\\IFC_V\\公用區\\115年感管查核\\手冊.pdf',
  'KM：50300-6-000002「抗微生物製劑管理計畫」'
].join('\n');
const sanitizedInternalPathSample = ctx.sanitizeLineText_(internalPathSample);
const internalPathFilterOk = !/[A-Z]:\\/i.test(sanitizedInternalPathSample) && sanitizedInternalPathSample.includes('KM：50300-6-000002');
if (!internalPathFilterOk) failures += 1;
outputs.push({
  id: 'sanitize-internal-drive-paths',
  ok: internalPathFilterOk,
  question: '[sanitize internal paths]',
  diseaseName: '評鑑查核',
  missing: internalPathFilterOk ? [] : ['KM evidence retained'],
  forbidden: /[A-Z]:\\/i.test(sanitizedInternalPathSample) ? ['internal drive path'] : [],
  missingQuick: [],
  forbiddenQuick: [],
  wrongQuickTail: null,
  quickReplyLabels: [],
  preview: sanitizedInternalPathSample.replace(/\n/g, ' ').slice(0, 260),
});

const originalLoadKb = ctx.loadKb_;
ctx.loadKb_ = () => ({ entries: [] });
vm.runInContext('AUDIT_RUNTIME_CACHE_ = null;', ctx);
const staleKbFallback = ctx.officialAuditClauseReply_('查核條文 5.1 重點');
ctx.loadKb_ = originalLoadKb;
const staleKbText = String(staleKbFallback && staleKbFallback.text || '');
const staleKbFallbackOk = [
  '查核條文 5.1',
  '預防接種',
  '委員可能的提問',
  'KM 可出示佐證',
  '健康監測通報規範與系統',
].every((term) => staleKbText.includes(term)) && !staleKbText.includes('正式資料目前尚未同步完成');
if (!staleKbFallbackOk) failures += 1;
outputs.push({
  id: 'audit-clause-stale-kb-external-file-fallback',
  ok: staleKbFallbackOk,
  question: '查核條文 5.1 重點 [stale KB]',
  diseaseName: '評鑑查核',
  missing: staleKbFallbackOk ? [] : ['usable external audit-clause response'],
  forbidden: staleKbText.includes('正式資料目前尚未同步完成') ? ['empty sync warning'] : [],
  missingQuick: [],
  forbiddenQuick: [],
  wrongQuickTail: null,
  quickReplyLabels: [],
  preview: staleKbText.replace(/\n/g, ' ').slice(0, 260),
});

console.log(JSON.stringify({ failures, total: outputs.length, outputs }, null, 2));
process.exitCode = failures ? 1 : 0;
