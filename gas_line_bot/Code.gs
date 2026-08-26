const CONFIG = {
  BOT_VERSION: '2026-08-26-needlestick-routing-2',
  KB_FILE_NAME: 'kb_index.json',
  AUDIT_FILE_NAME: 'audit_clauses.json',
  CLEARANCE_FILE_NAME: 'clearance_rules.json',
  MAX_HITS: 6,
  MIN_ANSWER_SCORE: 8,
  MIN_SUGGEST_SCORE: 3,
  MAX_CONTEXT_CHARS: 9000,
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
};

// Reuse the parsed Drive knowledge base throughout one webhook execution.
// The JSON is larger than the single-key CacheService limit, so without this
// guard one question can otherwise read and parse the same Drive file several times.
let KB_RUNTIME_CACHE_ = null;
let AUDIT_RUNTIME_CACHE_ = null;
let CLEARANCE_RUNTIME_CACHE_ = null;

function doGet(e) {
  return ContentService
    .createTextOutput('LINE Bot Webhook 運作正常！版本：' + CONFIG.BOT_VERSION)
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  console.log('>>> NEW DOPOST REQUEST RECEIVED AT ' + (new Date()).toLocaleString());
  try {
    if (!e) {
      console.log('doPost triggered manually from Editor UI. e is undefined.');
      return json_({ ok: true, message: 'doPost manual execution test OK' });
    }

    const body = e.postData && e.postData.contents ? e.postData.contents : '';
    const payload = JSON.parse(body || '{}');
    const events = payload.events || [];

    if (events.length === 0) {
      console.log('LINE Webhook Verify ping received successfully.');
      return json_({ ok: true, message: 'LINE Webhook Verify Success' });
    }

    events.forEach(function(event) {
      if (event.type === 'follow') {
        const followReplyToken = event.replyToken;
        if (!followReplyToken) return;
        const welcomeObj = finalizeAnswer_({
          text: followWelcomeReply_(),
          diseaseName: '閒聊'
        }, event, '', '', { skipCount: true });
        replyToLine_(followReplyToken, welcomeObj.text, welcomeObj.diseaseName, welcomeObj);
        return;
      }
      if (event.type !== 'message') return;
      if (!event.message || event.message.type !== 'text') return;
      const replyToken = event.replyToken;
      const question = String(event.message.text || '').trim();
      if (!replyToken || !question) return;

      console.log('Received question from LINE: ' + question);
      const answerObj = answerQuestion_(question, event);
      replyToLine_(replyToken, answerObj.text, answerObj.diseaseName, answerObj);
    });

    return json_({ ok: true });
  } catch (err) {
    console.error('doPost error: ' + err.toString());
    return json_({ ok: true });
  }
}

function answerQuestion_(question, event) {
  const originalQuestion = convertFullWidthToHalfWidth_(String(question || '')).trim();
  question = originalQuestion;

  // This high-frequency menu must never fall through to knowledge retrieval.
  const catheterReply = catheterCareReply_(question, event);
  if (catheterReply) {
    return finalizeAnswer_({
      text: catheterReply.text,
      diseaseName: '導管照護',
      subtopic: 'catheter-care',
      clarification: true,
      catheterPrompt: true
    }, event, originalQuestion, question, { skipCount: true });
  }

  const languageReply = languageGateReply_(question, event);
  if (languageReply) return finalizeAnswer_(languageReply, event, originalQuestion, question, { skipCount: true });

  const modeReply = modeSwitchReply_(question, event);
  if (modeReply) return finalizeAnswer_(modeReply, event, originalQuestion, question, { skipCount: true });

  const feedbackReply = feedbackResponseReply_(question, event);
  if (feedbackReply) return finalizeAnswer_({
    text: feedbackReply,
    diseaseName: '閒聊',
    qualityPrompt: isSatisfactionPromptCommand_(question) && isSatisfactionEligible_(event)
  }, event, originalQuestion, question, { skipCount: true });

  const suggestionReply = suggestionBoxReply_(question, event);
  if (suggestionReply) return finalizeAnswer_({ text: suggestionReply, diseaseName: '閒聊' }, event, originalQuestion, question, { skipCount: true });

  const auditGeneralReply = auditGeneralTopicReply_(question, event);
  if (auditGeneralReply) {
    return finalizeAnswer_({
      text: typeof auditGeneralReply === 'string' ? auditGeneralReply : auditGeneralReply.text,
      diseaseName: '評鑑查核',
      subtopic: 'audit',
      auditClauseId: auditGeneralReply.clauseId || '',
      auditClauseTitle: auditGeneralReply.clauseTitle || '',
      auditTopicMenu: auditGeneralReply.auditTopicMenu || ''
    }, event, originalQuestion, question);
  }

  if (/^(傳染病通報|法定傳染病通報|疾病通報)$/.test(normalizeIntentText_(question).replace(/\s+/g, ''))) {
    return finalizeAnswer_({
      text: '請輸入「疾病名稱＋查詢項目」，我才能提供正確規定：\n- 通報定義與時限\n- 採檢送驗\n- 隔離與院內處置\n\n例如：「麻疹通報」、「登革熱採檢」、「結核病隔離」。',
      diseaseName: '熱門感控',
      clarification: true,
      reportingPrompt: true
    }, event, originalQuestion, question, { skipCount: true });
  }

  const dialysisDisinfectionReply = dialysisDisinfectionConcentrationReply_(question, event);
  if (dialysisDisinfectionReply) {
    return finalizeAnswer_({
      text: dialysisDisinfectionReply,
      diseaseName: '透析室',
      subtopic: 'sanitization'
    }, event, originalQuestion, question);
  }

  const endoscopeReply = endoscopeReprocessingReply_(question);
  if (endoscopeReply) {
    return finalizeAnswer_({
      text: endoscopeReply,
      diseaseName: '內視鏡',
      subtopic: 'reprocessing'
    }, event, originalQuestion, question);
  }

  const fastReply = fastStaticReply_(question);
  if (fastReply) return finalizeAnswer_({ text: fastReply, diseaseName: '閒聊' }, event, originalQuestion, question, { skipCount: true });

  if (/^(會議檢索|查會議|查詢會議)$/.test(normalizeIntentText_(question))) {
    return finalizeAnswer_({
      text: '請輸入想查的議題，例如「感染月報在哪些週會出現」或「VRE在哪些月會出現」。系統只會顯示出現日期。',
      diseaseName: '會議檢索',
      clarification: true
    }, event, originalQuestion, question, { skipCount: true });
  }

  question = applyTopicCarryover_(question, event);

  const meetingReply = isMeetingRecordQuestion_(question) ? meetingRecordReply_(question) : '';
  if (meetingReply) return finalizeAnswer_({ text: meetingReply, diseaseName: '會議檢索' }, event, originalQuestion, question);

  const operationalRule = externalIntentRule_(normalizeIntentText_(question), 'operational');
  if (operationalRule) {
    return finalizeAnswer_({
      text: String(operationalRule.reply || ''),
      diseaseName: String(operationalRule.disease_name || '院內作業'),
      subtopic: 'operational',
      cjdAuditPrompt: String(operationalRule.disease_name || '') === '庫賈氏病'
    }, event, originalQuestion, question);
  }

  question = expandDiseaseAliasForSearch_(question);

  const smallTalk = smallTalkReply_(question, event);
  if (smallTalk) return finalizeAnswer_({ text: smallTalk, diseaseName: '閒聊' }, event, originalQuestion, question, { skipCount: true });

  const discordantInfluenzaReply = influenzaDiscordantTestReply_(question);
  if (discordantInfluenzaReply) {
    const needsRiskClarification = needsInfluenzaDiscordantRiskClarification_(question);
    return finalizeAnswer_({
      text: discordantInfluenzaReply,
      diseaseName: '流感',
      subtopic: 'isolation',
      clarification: needsRiskClarification,
      influenzaRiskPrompt: needsRiskClarification
    }, event, originalQuestion, question, { skipCount: needsRiskClarification });
  }

  if (isSeasonalInfluenzaClearanceQuestion_(question)) {
    return finalizeAnswer_({
      text: influenzaClearanceReply_(),
      diseaseName: '流感',
      subtopic: 'clearance'
    }, event, originalQuestion, question);
  }

  if (/帶狀[疱皰]疹/i.test(question) && /解隔|解除隔離|取消隔離/i.test(question)) {
    return finalizeAnswer_({
      text: zosterClearanceReply_(),
      diseaseName: '帶狀疱疹',
      subtopic: 'clearance'
    }, event, originalQuestion, question);
  }

  if (/瀰漫性帶狀[疱皰]疹/i.test(question) && /定義|什麼是|怎麼判斷|如何判斷/i.test(question)) {
    return finalizeAnswer_({
      text: disseminatedZosterDefinitionReply_(),
      diseaseName: '帶狀疱疹',
      subtopic: 'definition'
    }, event, originalQuestion, question);
  }

  const earlySubtopic = detectSubtopic_(question);
  if (!detectDisease_(question) && isAmbiguousSubtopicOnlyQuestion_(question, earlySubtopic)) {
    return finalizeAnswer_({
      text: genericSubtopicClarificationReply_(earlySubtopic),
      diseaseName: '熱門感控',
      subtopic: earlySubtopic,
      clarification: true
    }, event, originalQuestion, question, { skipCount: true });
  }

  // 1. 特殊醫令與 PEP 造冊分流
  if (isKpLabResultQuery_(question)) {
    return finalizeAnswer_({ text: kpLabResultReply_(), diseaseName: 'MDRO' }, event, originalQuestion, question);
  }
  if (isCdcn0146Query_(question)) {
    return finalizeAnswer_({ text: cdcn0146Reply_(), diseaseName: '百日咳' }, event, originalQuestion, question);
  }
  if (isPostExposurePepQuery_(question)) {
    const dis = detectDisease_(question);
    const dName = dis ? dis.name : '針扎與體液暴露';
    return finalizeAnswer_({ text: postExposurePepReply_(question), diseaseName: dName }, event, originalQuestion, question);
  }

  // 2. 結構化疾病感控與 SOP 處理
  const disease = detectDisease_(question);
  const testResultIsolationReply = diseaseTestResultIsolationReply_(question, disease);
  if (testResultIsolationReply) {
    return finalizeAnswer_({
      text: testResultIsolationReply,
      diseaseName: disease.name,
      subtopic: 'isolation'
    }, event, originalQuestion, question);
  }
  const countryEpidemicText = countryOrRegionEpidemicReply_(question);
  if (countryEpidemicText) {
    return finalizeAnswer_({ text: countryEpidemicText, diseaseName: '疫情資訊' }, event, originalQuestion, question);
  }
  if (isTravelEpidemicQuery_(question)) {
    const epidemicText = travelEpidemicReply_(question, disease);
    if (epidemicText) {
      return finalizeAnswer_({ text: epidemicText, diseaseName: disease ? disease.name : '熱門感控' }, event, originalQuestion, question);
    }
  }

  if (disease) {
    const subtopic = detectSubtopic_(question);
    const isCjdDetailQuery = disease.name === '庫賈氏病' && /勾稽|風險判定|鼻腔|器械|去活化|KM佐證/i.test(question);
    if (getUserMode_(event) === 'audit' && !subtopic && !isCjdDetailQuery) {
      const auditReply = auditDiseaseTopicReply_(disease.name);
      if (auditReply) {
        return finalizeAnswer_({
          text: auditReply,
          diseaseName: disease.name,
          subtopic: 'audit',
          cjdAuditPrompt: disease.name === '庫賈氏病'
        }, event, originalQuestion, question);
      }
    }
    if (shouldClarifyDiseaseQuestion_(originalQuestion, disease.name, subtopic) || shouldClarifyDiseaseQuestion_(question, disease.name, subtopic)) {
      return finalizeAnswer_({
        text: diseaseClarificationReply_(disease.name),
        diseaseName: disease.name,
        clarification: true
      }, event, originalQuestion, question, { skipCount: true });
    }
    if (subtopic === 'definition') {
      const definitionReply = cdcNotificationDefinitionReply_(disease.name);
      if (definitionReply) {
        return finalizeAnswer_({ text: definitionReply, diseaseName: disease.name, subtopic: subtopic }, event, originalQuestion, question);
      }
    }
    if (subtopic === 'specimen') {
      const specimenReply = cdcSpecimenReply_(disease.name);
      if (specimenReply) {
        return finalizeAnswer_({ text: specimenReply, diseaseName: disease.name, subtopic: subtopic }, event, originalQuestion, question);
      }
    }
    if (subtopic === 'clearance') {
      const clearanceReply = mdroClearanceReply_(disease.name) || generalClearanceReply_(disease.name);
      if (clearanceReply) {
        return finalizeAnswer_({ text: clearanceReply, diseaseName: disease.name, subtopic: subtopic }, event, originalQuestion, question);
      }
    }
    const profile = diseaseInfectionControlProfile_(disease.name);
    if (profile) {
      if (subtopic) {
        const subReply = diseaseSubtopicReply_(disease.name, profile, subtopic);
        if (subReply) return finalizeAnswer_({ text: subReply, diseaseName: disease.name, subtopic: subtopic }, event, originalQuestion, question);
      }
      return finalizeAnswer_({ text: diseaseFullOverviewReply_(disease.name, profile), diseaseName: disease.name }, event, originalQuestion, question);
    }
    if (subtopic === 'sanitization') {
      return finalizeAnswer_({
        text: genericDiseaseSanitizationReply_(disease.name),
        diseaseName: disease.name,
        subtopic: subtopic
      }, event, originalQuestion, question);
    }
  }

  // 3. 知識庫檢索與 AI 搜尋
  const hits = searchKb_(question, CONFIG.MAX_HITS);
  if (!hits.length || Number(hits[0]._score || 0) < CONFIG.MIN_SUGGEST_SCORE) {
    const scopedFallback = disease && detectSubtopic_(question)
      ? safeDiseaseSubtopicFallback_(disease.name, detectSubtopic_(question))
      : '';
    if (scopedFallback) {
      return finalizeAnswer_({
        text: scopedFallback,
        diseaseName: disease.name,
        subtopic: detectSubtopic_(question)
      }, event, originalQuestion, question);
    }
    return finalizeAnswer_({
      text: '您好！我是台大感染管制小幫手 🤖\n\n目前未檢索到完全相符的規範，您可以直接點選下方快捷按鈕，或輸入「疾病名稱 + 查詢項目」（例如：麻疹暴露、百日咳採檢、VRE隔離、兔熱病通報），我會即時為您整理重點！',
      diseaseName: disease ? disease.name : '熱門感控'
    }, event, originalQuestion, question, { skipCount: true });
  }

  if (Number(hits[0]._score || 0) < CONFIG.MIN_ANSWER_SCORE) {
    const scopedFallback = disease && detectSubtopic_(question)
      ? safeDiseaseSubtopicFallback_(disease.name, detectSubtopic_(question))
      : '';
    if (scopedFallback) {
      return finalizeAnswer_({
        text: scopedFallback,
        diseaseName: disease.name,
        subtopic: detectSubtopic_(question)
      }, event, originalQuestion, question);
    }
    return finalizeAnswer_({ text: suggestTopics_(question, hits), diseaseName: disease ? disease.name : '熱門感控' }, event, originalQuestion, question, { skipCount: true });
  }

  const context = buildContext_(hits, CONFIG.MAX_CONTEXT_CHARS);
  const geminiAnswer = callGemini_(question, context, getUserLanguage_(event));
  if (geminiAnswer) return finalizeAnswer_({
    text: cleanAnswerText_(geminiAnswer),
    diseaseName: disease ? disease.name : '熱門感控',
    cjdAuditPrompt: !!(disease && disease.name === '庫賈氏病' && getUserMode_(event) === 'audit')
  }, event, originalQuestion, question);

  return finalizeAnswer_({
    text: disease && detectSubtopic_(question)
      ? diseaseScopedExtractiveAnswer_(hits, disease.name, detectSubtopic_(question))
      : extractiveAnswer_(hits, disease ? disease.name : ''),
    diseaseName: disease ? disease.name : '熱門感控',
    cjdAuditPrompt: !!(disease && disease.name === '庫賈氏病' && getUserMode_(event) === 'audit')
  }, event, originalQuestion, question);
}

function followWelcomeReply_() {
  return '歡迎使用台大感管 LINE 查詢助手。\n\n可查感染管制、法定傳染病通報、隔離/解隔、採檢送驗、PPE、清消、疫區及院內一般流程。\n\n回答方向可隨時切換：\n- 臨床照護：優先整理病人安置、隔離醫囑、PPE、採檢及現場處置。\n- 評鑑查核：優先整理委員可能的提問、KM 佐證及可出示的執行紀錄。\n請點下方快捷鈕選擇；之後仍可切換。\n\n本帳號不提供疾病診斷、醫師推薦、就醫科別、掛號或個案治療建議；相關需求請使用台大醫院 App、官方網站或正式掛號諮詢。';
}

function dialysisDisinfectionConcentrationReply_(question, event) {
  const q = normalizeIntentText_(question);
  if (!/(透析室|血液透析室|洗腎室|透析機)/i.test(q)) return '';
  if (!/(消毒|清消|清潔|漂白水|濃度)/i.test(q)) return '';
  const clinicalSummary = '透析室清潔消毒濃度：\n' +
    '- 桌椅、床旁環境表面及地面：1,000 ppm 漂白水（以 5% 原液約 1:50 稀釋）。\n' +
    '- 血液／體液污染小於 10 mL：1,000 ppm 覆蓋 10 分鐘；大於 10 mL：5,000 ppm 覆蓋 10 分鐘，移除髒污後再清潔消毒。\n' +
    '- 透析機表面及器械：每位病人使用後，以設備相容的消毒劑擦拭；內部血液滲漏依機器規範完成內外部清潔及化學消毒。';
  if (getUserMode_(event) !== 'audit') return clinicalSummary;
  return clinicalSummary + '\n\n評鑑查核可出示：\n' +
    '- KM：50300-3-000011「透析室感染管制措施」。\n' +
    '- 現場紀錄：漂白水泡製／濃度與日期標示、每位病人後透析機及環境清消紀錄。\n' +
    '- 設備紀錄：透析機維護、化學消毒及血液滲漏處理紀錄。\n' +
    '- 人員佐證：血液／體液污染清除流程及教育訓練紀錄。';
}

function endoscopeReprocessingReply_(question) {
  const q = normalizeIntentText_(question);
  if (!/內視鏡/i.test(q) || /庫賈氏|CJD|鼻腔手術/i.test(q)) return '';

  if (/微生物.*(監測|異常)|監測.*異常/i.test(q)) {
    return '內視鏡微生物監測異常處理：\n' +
      '- 該內視鏡先暫停使用，完成原因分析與改善。\n' +
      '- 查核採檢步驟、再處理流程、消毒劑有效濃度、自動化再處理機功能及環境清潔。\n' +
      '- 依流程執行雙重高層次消毒或滅菌後複檢；仍不合格則送原廠處理，至複檢合格才可恢復使用。\n' +
      '- 同步依感染管制中心流程追蹤曾使用該鏡之病人及相關紀錄。\n' +
      'KM：50300-2-000010「內視鏡再處理作業管理要點」及其微生物監測異常處理附件。';
  }
  if (/乾燥|儲存|存放/i.test(q)) {
    return '內視鏡乾燥與儲存重點：\n' +
      '- 最後漂清後執行 Alcohol flush，並以自動化再處理機 Air purge 或手動乾燥 10 分鐘加強乾燥。\n' +
      '- 依儲存櫃規範水平或垂直存放，避免鏡身互相碰撞；垂直懸掛時不可接觸櫃底。\n' +
      '- 一般內視鏡儲存超過 7 日須重新高層次消毒；十二指腸鏡及線性超音波內視鏡超過 3 日須重新處理。\n' +
      'KM：50300-2-000010「內視鏡再處理作業管理要點」附件二、三及相關技術稽核表。';
  }
  if (/手工清洗|刷洗/i.test(q)) {
    return '內視鏡手工清洗重點：\n' +
      '- 檢查後先完成前置清洗及安全覆蓋運送，再依型號與廠商說明書執行測漏。\n' +
      '- 在流動水下刷洗吸引管路、處置管路及所有管腔；管路刷至少通過 3 次，直到刷毛無可見殘渣，雙頭刷不回抽。\n' +
      '- 刷洗後完整漂清，再進入高層次消毒；清洗不完整時不可直接以消毒取代。\n' +
      'KM：50300-2-000010「內視鏡再處理作業管理要點」及內視鏡再處理技術稽核表。';
  }
  if (/高層次消毒/i.test(q)) {
    return '內視鏡高層次消毒重點：\n' +
      '- 原則上使用自動化內視鏡再處理機；實務上無法採自動化處理時，才依核定流程執行手工高層次消毒。\n' +
      '- 消毒前必須完成測漏、手工清洗及漂清；內視鏡與所有管路均須完整接觸消毒劑。\n' +
      '- 消毒劑濃度、溫度與接觸時間依院內核定流程及產品說明執行，並留下高層次消毒日期紀錄。\n' +
      'KM：50300-2-000010「內視鏡再處理作業管理要點」附件二、三。';
  }
  if (/^(內視鏡|內視鏡再處理|內視鏡再處理流程)$/i.test(q)) {
    return '內視鏡再處理流程重點：\n' +
      '- 依序完成檢查後前置清洗、安全覆蓋運送、測漏、手工清洗、漂清、高層次消毒、最後漂清、乾燥及專用儲存櫃儲存。\n' +
      '- 再處理區須張貼適用流程；操作人員穿戴適當 PPE，新進人員完成訓練及技術查核後才可執行。\n' +
      '- 每次使用均應留下可追溯紀錄，並確認消毒劑有效濃度及容器最低有效濃度檢測。\n' +
      'KM：50300-2-000010「內視鏡再處理作業管理要點」及附件二至八。';
  }
  return '';
}

function fastStaticReply_(question) {
  const q = normalizeIntentText_(question);
  if (/^(可以查什麼|可以問什麼|你能做什麼|你能查什麼|你能回答什麼|你能答什麼|你可以做什麼|你可以回答什麼|你可以答什麼|你會做什麼|你能幫我什麼|你提供什麼服務|有什麼功能|你現在有什麼在執行的事|你現在在執行什麼|你目前在執行什麼|你現在在做什麼|你目前在做什麼|選單|主選單|目錄|說明|幫助|功能|help|menu|\?|？)$/.test(q)) {
    return '您好，我是台大感管 LINE 查詢助手。可查感染管制、法定傳染病通報、隔離/解隔、檢體送驗、疫區、清消濃度、查核重點，也可查週會/月會議題曾在哪些日期出現。\n\n提問範例：VRE 解隔、登革熱通報、伊波拉疫區、感染月報在哪些週會出現。';
  }
  return '';
}

function modeSwitchReply_(question, event) {
  const q = String(question || '').trim();
  if (/^(評鑑查核|評鑑查核模式|查核模式|評鑑模式|委員查核)$/i.test(q)) {
    saveUserMode_(event, 'audit');
    return {
      text: '已切換為評鑑查核模式。\n\n之後回答會優先提醒：查核委員可能追問什麼、現場同仁怎麼回答、需要準備哪些紀錄或佐證。若要回到第一線處置，請點「臨床照護」。',
      diseaseName: '模式切換'
    };
  }
  if (/^(臨床照護|臨床照護模式|臨床模式|照護模式|第一線照護)$/i.test(q)) {
    saveUserMode_(event, 'clinical');
    return {
      text: '已切換為臨床照護模式。\n\n之後回答會優先整理：病人安置、隔離醫囑、PPE、採檢送驗、清消與現場可執行步驟。若遇到查核或委員提問，請點「評鑑查核」。',
      diseaseName: '模式切換'
    };
  }
  return null;
}

function modeAwareAnswer_(answerObj, event) {
  const mode = getUserMode_(event);
  const obj = answerObj || { text: '', diseaseName: '' };
  obj.text = String(obj.text || '').trim();
  obj.mode = mode;
  obj.modeExplicit = hasExplicitUserMode_(event);
  obj.identity = getUserIdentity_(event);
  return obj;
}

function finalizeAnswer_(answerObj, event, originalQuestion, effectiveQuestion, options) {
  const opts = options || {};
  const obj = modeAwareAnswer_(answerObj, event);
  obj.originalQuestion = String(originalQuestion || '');
  obj.effectiveQuestion = String(effectiveQuestion || originalQuestion || '');
  const shouldCount = !opts.skipCount && isCountableAnswer_(obj, originalQuestion, effectiveQuestion);
  const prompt = updateConversationState_(event, originalQuestion, effectiveQuestion, obj, shouldCount);
  if (prompt && obj.text.indexOf(prompt) < 0) {
    obj.text = String(obj.text || '').trim() + '\n\n' + prompt;
    obj.qualityPrompt = true;
  }
  obj.satisfactionEligible = isSatisfactionEligible_(event);
  obj.text = appendPolicySummaryReminder_(obj.text, obj, effectiveQuestion);
  obj.text = appendPrivacyReminder_(obj.text);
  obj.text = translateAnswerForUserLanguage_(obj.text, event, obj);
  return obj;
}

function appendPolicySummaryReminder_(text, answerObj, question) {
  const body = String(text || '').trim();
  const obj = answerObj || {};
  const reminder = '如與正式公告不一致，以正式公告為準。';
  if (!body || body.indexOf(reminder) >= 0) return body;
  if (obj.clarification || obj.diseaseName === '會議檢索' || obj.diseaseName === '閒聊' || obj.diseaseName === '語言切換') return body;
  return body + '\n\n' + reminder;
}

function appendPrivacyReminder_(text) {
  const body = String(text || '').trim();
  const reminder = '請勿輸入病人姓名、病歷號、床號等個資。';
  const policyReminder = '如與正式公告不一致，以正式公告為準。';
  if (!body || body.indexOf(reminder) >= 0) return body;
  return body + (body.endsWith(policyReminder) ? ' ' : '\n\n') + reminder;
}

function getUserLanguage_(event) {
  const userId = getLineUserId_(event);
  if (!userId) return 'zh-TW';
  const state = getUserState_(userId);
  return state.language || 'zh-TW';
}

function languagePromptText_(detectedLanguage) {
  const lang = String(detectedLanguage || '').trim();
  if (lang) {
    return '偵測到您可能使用 ' + lang + '。\n\n' +
      '本帳號預設以繁體中文回答；若希望改用其他語言，請點選下方按鈕。\n\n' +
      'I detected ' + lang + '. This bot defaults to Traditional Chinese. Tap a language below if you prefer another language.';
  }
  return '歡迎使用台大醫院感染管制中心 LINE 官方帳號！\n' +
    'Welcome to NTUH Infection Control Center LINE Bot!\n' +
    'Selamat datang di Bot LINE Pengendalian Infeksi NTUH!\n' +
    'Chào mừng bạn đến với LINE Bot Kiểm soát Nhiễm khuẩn NTUH!\n\n' +
    '請選擇您偏好的語言 / Please select your preferred language:';
}

function isLanguageResetKeyword_(question) {
  const q = normalizeIntentText_(question);
  if (/^(語言|切換語言|換語言|重設語言|選擇語言|多語言)$/.test(q)) return true;
  if (/^(language|changelanguage|switchlanguage|resetlanguage|selectlanguage|lang)$/i.test(q)) return true;
  if (/^(bahasa|gantibahasa|ubahbahasa|pilihbahasa)$/i.test(q)) return true;
  if (/^(ngônngữ|ngonngu|đổingônngữ|doingonngu|chọnngônngữ|chonngonngu)$/i.test(q)) return true;
  return false;
}

function languageChoice_(question) {
  const q = String(question || '').trim().toLowerCase();
  if (/^(繁體中文|中文|國語|華語|zh-tw|zh_tw|chinese|traditional chinese|🇹🇼)$/i.test(q)) return 'zh-TW';
  if (/^(english|eng|en|英文|英語|🇺🇸|🇬🇧)$/i.test(q)) return 'en';
  if (/^(bahasa indonesia|bahasa|indonesia|indonesian|印尼文|印尼語|🇮🇩)$/i.test(q)) return 'id';
  if (/^(tiếng việt|tieng viet|vietnamese|vietnam|越南文|越南語|🇻🇳)$/i.test(q)) return 'vi';
  return '';
}

function languageSetReplyText_(language) {
  if (language === 'en') {
    return 'Language has been set to English.\n\nYou may ask infection-control, travel-health, isolation, specimen, or reporting questions in English.';
  }
  if (language === 'id') {
    return 'Bahasa telah diatur ke Bahasa Indonesia.\n\nAnda dapat bertanya tentang pencegahan infeksi, isolasi, spesimen, pelaporan, atau informasi perjalanan.';
  }
  if (language === 'vi') {
    return 'Ngôn ngữ đã được đặt thành Tiếng Việt.\n\nBạn có thể hỏi về kiểm soát nhiễm khuẩn, cách ly, bệnh phẩm, khai báo hoặc thông tin du lịch.';
  }
  return '語言已設定為繁體中文。\n\n可繼續詢問感染管制、隔離醫囑、採檢送驗、通報定義、疫區或查核相關問題。';
}

function detectForeignLanguageForPrompt_(question) {
  const raw = String(question || '').trim();
  if (!raw) return '';
  if (/[\u4e00-\u9fff]/.test(raw)) return '';
  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]+/g, '');
  if (!compact) return '';
  if (/^(vre|cre|mrsa|mrse|crab|crpa|mdro|mdroe|kp|tb|hiv|hbv|hcv|covid|cjd|ppe|jev|hib|ipd)$/.test(compact)) return '';
  if (/^(influenzaa|influenzab|flu|ebola|mpox|malaria|measles|rubella|mumps|scabies|dengue|chikungunya|zika|cholera)$/.test(compact)) return '';
  if (/\b(apa|bagaimana|saya|anda|rumah sakit|infeksi|isolasi|bahasa)\b/i.test(lower)) return 'Bahasa Indonesia';
  if (/\b(toi|tôi|ban|bạn|benh|bệnh|cach|cách|nguy|hiem|hiểm|ngon ngu|ngôn ngữ)\b/i.test(lower)) return 'Tiếng Việt';
  if (/\b(what|how|when|where|why|can|should|need|report|isolation|specimen|infection|travel|hospital|patient|fever|cough)\b/i.test(lower)) return 'English';
  return '';
}

function languageGateReply_(question, event) {
  const userId = getLineUserId_(event);
  if (!userId) return null;
  const q = String(question || '').trim();
  const state = getUserState_(userId);

  if (isLanguageResetKeyword_(q)) {
    return { text: languagePromptText_(''), diseaseName: '語言切換', languagePrompt: true };
  }

  const selected = languageChoice_(q);
  if (selected) {
    state.language = selected;
    saveUserState_(userId, state);
    return { text: languageSetReplyText_(selected), diseaseName: '語言切換', languagePrompt: true };
  }

  const detected = detectForeignLanguageForPrompt_(q);
  if (detected && !state.languagePrompted && (state.language || 'zh-TW') === 'zh-TW') {
    state.languagePrompted = true;
    saveUserState_(userId, state);
    return { text: languagePromptText_(detected), diseaseName: '語言切換', languagePrompt: true };
  }

  return null;
}

function isCountableAnswer_(answerObj, originalQuestion, effectiveQuestion) {
  const d = String(answerObj && answerObj.diseaseName || '');
  if (!d || d === '閒聊' || d === '模式切換') return false;
  const q = String(originalQuestion || effectiveQuestion || '');
  if (isLowValueOrMetaQuestion_(q)) return false;
  return true;
}

function applyTopicCarryover_(question, event) {
  const q = convertFullWidthToHalfWidth_(String(question || '')).trim();
  const userId = getLineUserId_(event);
  if (!q || !userId) return q;
  const state = getUserState_(userId);
  const lastTopic = String(state.lastTopic || '').trim();
  if (!lastTopic || Number(state.topicChainCount || 0) >= 5) return q;
  if (isExplicitDifferentTopic_(q, state)) return q;
  if (!isTopicFollowupQuestion_(q)) return q;
  if (isStyleOnlyFollowup_(q) && state.lastSubtopic) {
    return lastTopic + ' ' + subtopicLabel_(state.lastSubtopic) + ' ' + q;
  }
  return lastTopic + ' ' + q;
}

function isTopicFollowupQuestion_(question) {
  const q = normalizeIntentText_(question);
  if (!q) return false;
  if (/^(白話一點|白話|講人話|說人話|簡單講|回答短一點|只回答重點|只列流程|只列醫囑|用查核口吻|用臨床流程回答|補檢體|請補檢體|補診斷條件|補通報定義|補臨床流程|補院內系統操作)$/.test(q)) return true;
  if (/^(通報定義|通報|採檢|送驗|檢體|採檢送驗|隔離|隔離醫囑|解隔|解除隔離|解隔標準|取消隔離|ppe|防護|病人安置|床位|病房|清消|消毒|漂白水|暴露|造冊|預防用藥|抗病毒|抗蟲藥|用藥|醫令|開方|診斷碼|流程|系統操作|轉送|檢查)$/.test(q)) return true;
  return q.length <= 8 && /定義|流程|醫囑|檢體|安置|床位|防護|清消|解隔|隔離|造冊|暴露|疫區/.test(q);
}

function isAmbiguousSubtopicOnlyQuestion_(question, subtopic) {
  if (!subtopic) return false;
  const q = normalizeIntentText_(question);
  if (!q) return false;
  if (detectDisease_(q)) return false;
  return /^(通報定義|病例定義|診斷要件|通報|採檢|送驗|檢體|採檢送驗|隔離|隔離醫囑|解隔|解除隔離|解隔標準|取消隔離|ppe|防護|病人安置|床位|病房|清消|消毒|漂白水|暴露|造冊|預防用藥|抗病毒|抗蟲藥|用藥|醫令|開方|診斷碼|流程|系統操作|轉送|檢查)$/.test(q);
}

function genericSubtopicClarificationReply_(subtopic) {
  const label = subtopicLabel_(subtopic) || '查詢項目';
  if (subtopic === 'clearance') {
    return '請問您要查哪一種疾病或菌株的解隔標準？\n\n' +
      '不同疾病差很多，例如 VRE 要看原部位與肛門/直腸篩檢，流感看症狀與院內解隔規範，水痘看水泡是否全數結痂。\n\n' +
      '可直接點下方快捷鈕，或輸入「VRE解隔」、「流感解隔」、「水痘解隔」。';
  }
  if (subtopic === 'definition') {
    return '請問您要查哪一個疾病的通報定義？\n\n' +
      '請用「疾病名稱 + 通報定義」詢問，例如「麻疹通報定義」、「未定型肝炎通報定義」、「新型A型流感通報定義」。';
  }
  if (subtopic === 'specimen') {
    return '請問您要查哪一個疾病的採檢送驗？\n\n' +
      '請用「疾病名稱 + 採檢」詢問，例如「日腦採檢」、「流腦採檢」、「登革熱採檢」。MDRO 類則通常是送本院檢醫部，不是送 CDC。';
  }
  return '請問您要查哪一個疾病或情境的「' + label + '」？\n\n' +
    '請用「疾病名稱 + 想問項目」詢問，例如「登革熱隔離醫囑」、「VRE病人安置」、「麻疹暴露」、「透析室清消」。';
}

function shouldClarifyDiseaseQuestion_(question, diseaseName, subtopic) {
  const q = normalizeIntentText_(question);
  if (!diseaseName || subtopic) return false;
  if (/疫區|旅遊疫情|有何疫情|有哪些疫情|特殊傳染病/.test(q)) return false;
  if (/檢驗出|培養出|報告出|陽性|篩檢陽性/.test(q)) return false;
  if (isAliasOnlyDiseaseQuestion_(question, diseaseName)) return true;
  const compactDisease = normalizeIntentText_(diseaseName);
  if (q === compactDisease) return true;
  if (q.replace(compactDisease, '') === '') return true;
  if (/感染管制|感控|sop|處置|流程|怎麼辦|注意事項|照護重點|臨床處置|標準流程/.test(q)) return true;
  return false;
}

function isAliasOnlyDiseaseQuestion_(question, diseaseName) {
  const q = compactAliasText_(question);
  if (!q || q.length > 18) return false;
  const terms = [diseaseName];
  try {
    const kb = loadKb_();
    const synonyms = kb.synonyms || {};
    const list = synonyms[diseaseName] || synonyms[String(diseaseName || '').trim()] || [];
    list.forEach(function(item) { terms.push(item); });
  } catch (err) {
    // Keep clarification working even if the Drive cache is temporarily unavailable.
  }
  for (let i = 0; i < terms.length; i++) {
    const term = compactAliasText_(terms[i]);
    if (term && q === term) return true;
  }
  return false;
}

function diseaseClarificationReply_(diseaseName) {
  const d = String(diseaseName || '這個疾病').trim();
  return d + '可以查的範圍很多，我先幫您釐清方向，避免一次回答太散。\n\n' +
    '請點下方快捷鈕，或直接輸入：\n' +
    '- ' + d + '通報定義\n' +
    '- ' + d + '隔離醫囑\n' +
    '- ' + d + '病人安置\n' +
    '- ' + d + '採檢送驗\n' +
    '- ' + d + 'PPE\n' +
    '- ' + d + '清消\n' +
    '- ' + d + '解隔標準';
}

function isStyleOnlyFollowup_(question) {
  const q = normalizeIntentText_(question);
  return /^(白話一點|白話|講人話|說人話|簡單講|回答短一點|只回答重點|只列流程|只列醫囑|用查核口吻|用臨床流程回答)$/.test(q);
}

function subtopicLabel_(subtopic) {
  const map = {
    placement: '病人安置',
    order: '隔離醫囑',
    specimen: '採檢送驗',
    isolation: '隔離醫囑',
    clearance: '解隔標準',
    exposure: '暴露處置',
    sanitization: '清消',
    care: 'PPE防護'
  };
  return map[subtopic] || '';
}

function expandDiseaseAliasForSearch_(question) {
  const q = convertFullWidthToHalfWidth_(String(question || '')).trim();
  if (!q) return q;
  try {
    const kb = loadKb_();
    const synonyms = kb && kb.synonyms ? kb.synonyms : {};
    const compact = compactAliasText_(q);
    const keys = Object.keys(synonyms || {});
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!isDiseaseSynonymKey_(key)) continue;
      const terms = [key].concat(synonyms[key] || []);
      for (let j = 0; j < terms.length; j++) {
        if (aliasTermMatches_(compact, terms[j]) && compact.indexOf(compactAliasText_(key)) < 0) {
          return key + ' ' + q;
        }
      }
    }
    const fuzzyKey = fuzzyDiseaseAliasKey_(q, synonyms);
    if (fuzzyKey && compact.indexOf(compactAliasText_(fuzzyKey)) < 0) {
      return fuzzyKey + ' ' + q;
    }
  } catch (err) {
    console.error('expandDiseaseAliasForSearch_ skipped: ' + err.toString());
  }
  return q;
}

function fuzzyDiseaseAliasKey_(question, synonyms) {
  const candidate = compactAliasText_(question)
    .replace(/^(請問|想問|查詢|幫我|麻煩)/, '')
    .replace(/(通報定義|病例定義|通報|隔離醫囑|隔離|解隔標準|解隔|採檢送驗|採檢|送驗|檢體|疫區|清消|消毒|ppe|防護|病人安置|怎麼辦|是什麼)$/i, '');
  if (!candidate) return '';
  const isCjk = /^[\u4e00-\u9fff]{3,12}$/.test(candidate);
  const isLatin = /^[a-z]{5,24}$/.test(candidate);
  if (!isCjk && !isLatin) return '';

  const maxDistance = isCjk ? 1 : (candidate.length >= 7 ? 2 : 1);
  let bestKey = '';
  let bestDistance = maxDistance + 1;
  let tied = false;
  const keys = Object.keys(synonyms || {});
  keys.forEach(function(key) {
    if (!isDiseaseSynonymKey_(key)) return;
    const terms = [key].concat(synonyms[key] || []);
    terms.forEach(function(term) {
      const t = compactAliasText_(term);
      if ((isCjk && !/^[\u4e00-\u9fff]{3,12}$/.test(t)) || (isLatin && !/^[a-z]{5,24}$/.test(t))) return;
      if (Math.abs(t.length - candidate.length) > maxDistance) return;
      const distance = levenshteinDistance_(candidate, t, maxDistance);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = key;
        tied = false;
      } else if (distance === bestDistance && key !== bestKey) {
        tied = true;
      }
    });
  });
  return bestDistance <= maxDistance && !tied ? bestKey : '';
}

function levenshteinDistance_(a, b, stopAfter) {
  const left = String(a || '');
  const right = String(b || '');
  let previous = [];
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1)
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > stopAfter) return stopAfter + 1;
    previous = current;
  }
  return previous[right.length];
}

function compactAliasText_(text) {
  return convertFullWidthToHalfWidth_(String(text || ''))
    .replace(/\s+/g, '')
    .replace(/[，。！？?！、；;：:「」『』"'`]/g, '')
    .toLowerCase();
}

function aliasTermMatches_(compactQuestion, term) {
  const t = compactAliasText_(term);
  if (!t || t.length < 2) return false;
  return compactQuestion.indexOf(t) >= 0;
}

function isDiseaseSynonymKey_(key) {
  const k = String(key || '');
  if (!k) return false;
  return !/^(通報|診斷要件|診斷碼|檢體|疫區|隔離|解隔|外出檢查|清消|透析室|內視鏡|員工健康|標示|標記註記|藥物|抗藥菌|民眾衛教|查核|會議檢索)$/i.test(k);
}

function isExplicitDifferentTopic_(question, state) {
  const q = String(question || '');
  const lastDisease = String(state.lastDiseaseName || '');
  const currentDisease = detectDisease_(q);
  if (currentDisease && currentDisease.name && currentDisease.name !== lastDisease) return true;
  if (isMeetingRecordQuestion_(q) && String(state.lastDiseaseName || '') !== '會議檢索') return true;
  if (isTravelEpidemicQuery_(q) && !isTopicFollowupQuestion_(q)) return true;
  if (/內視鏡|透析|洗腎|手部衛生|乾洗手|酒精|感管中心|辦公室|意見箱|滿意度|可以查什麼|可以問什麼/.test(q)) return true;
  return false;
}

function updateConversationState_(event, originalQuestion, effectiveQuestion, answerObj, shouldCount) {
  const userId = getLineUserId_(event);
  if (!userId) return '';
  const state = getUserState_(userId);
  const now = new Date().toISOString();
  const topicInfo = inferAnswerTopic_(effectiveQuestion, answerObj);

  if (topicInfo.topic) {
    if (state.lastTopic === topicInfo.topic) {
      state.topicChainCount = Math.min(5, Number(state.topicChainCount || 0) + 1);
    } else {
      state.lastTopic = topicInfo.topic;
      state.topicChainCount = 1;
    }
    state.lastDiseaseName = topicInfo.diseaseName || '';
  }

  state.lastQuestion = String(originalQuestion || '').slice(0, 160);
  state.lastEffectiveQuestion = String(effectiveQuestion || '').slice(0, 180);
  state.lastAnswerDiseaseName = String(answerObj && answerObj.diseaseName || '').slice(0, 60);
  state.lastSubtopic = detectSubtopic_(effectiveQuestion) || state.lastSubtopic || '';
  state.lastQuestionAt = now;

  let prompt = '';
  if (shouldCount) {
    state.validQuestionCount = Number(state.validQuestionCount || 0) + 1;
    if (!state.qualityPrompted && state.validQuestionCount >= 5) {
      state.qualityPrompted = true;
      state.qualityPromptedAt = now;
      prompt = qualityPromptText_();
    }
  }

  saveUserState_(userId, state);
  return prompt;
}

function inferAnswerTopic_(question, answerObj) {
  const d = String(answerObj && answerObj.diseaseName || '').trim();
  if (d && d !== '熱門感控' && d !== '本疾病' && d !== '閒聊' && d !== '模式切換') {
    return { topic: d, diseaseName: d === '會議檢索' ? '會議檢索' : d };
  }
  const disease = detectDisease_(question);
  if (disease && disease.name) return { topic: disease.name, diseaseName: disease.name };
  const meetingTopic = isMeetingRecordQuestion_(question) ? extractMeetingTopic_(question) : '';
  if (meetingTopic) return { topic: meetingTopic, diseaseName: '會議檢索' };
  return { topic: '', diseaseName: '' };
}

function qualityPromptText_() {
  return '【滿意度調查｜非醫療處置選項】\n以下 1-5 分是評估剛才的回答是否有幫助，不是病人處置選項。請點下方「滿意度」按鈕評分；也可輸入「感管意見箱」留下建議。';
}

function isMeetingRecordQuestion_(question) {
  const q = normalizeIntentText_(question);
  const meetingTerm = /會議|會報|週會|月會|委員會|感管會|會議紀錄|會議記錄|會議討論|會報紀錄/;
  const queryTerm = /在哪|哪個|哪次|哪一次|曾在哪|何時|有無|討論過|紀錄|記錄|日期|時間|出現/;
  return meetingTerm.test(q) && queryTerm.test(q);
}

function meetingRecordReply_(question) {
  const q = String(question || '');
  const topic = extractMeetingTopic_(q);
  if (!topic) {
    return '請用「議題 + 週會/月會」查詢會議紀錄，例如：感染月報在哪些週會出現、空調檢測在哪些週會出現、VRE在哪些月會出現。';
  }

  const scope = /週會/.test(q) && !/月會/.test(q) ? 'weekly' : (/月會|委員會|感管會/.test(q) && !/週會/.test(q) ? 'monthly' : 'all');
  const cacheKey = 'meeting_dates_only_v2_' + scope + '_' + topic.replace(/[^\w\u4e00-\u9fff]/g, '').slice(0, 28);
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const docs = loadMeetingDocTexts_(scope);
  const hits = searchMeetingDocs_(docs, topic, q);
  let answer = '';

  if (!hits.length) {
    answer = '目前在週會/月會檢索檔沒有找到「' + topic + '」的明確命中。\n\n' +
      '可以換較短或較常見的關鍵字再查一次，例如「感染月報」、「空調」、「VRE」、「內視鏡」、「手部衛生」。';
  } else {
    const dateSet = {};
    hits.forEach(function(hit) {
      hit.dates.forEach(function(date) { dateSet[date] = true; });
    });
    const dates = Object.keys(dateSet).sort();
    answer = dates.length
      ? '「' + topic + '」查得日期：\n' + dates.slice(0, 30).join('、') + (dates.length > 30 ? ' 等' + dates.length + '筆' : '')
      : '目前找到「' + topic + '」相關紀錄，但檢索資料沒有可供顯示的明確日期。';
  }

  if (answer.length < 90000) cache.put(cacheKey, answer, 600);
  return answer;
}

function extractMeetingTopic_(question) {
  let q = normalizeIntentText_(question);
  q = q
    .replace(/請問|想問|查詢|幫我|可以|麻煩|一下|一下子/g, '')
    .replace(/在哪些|在哪個|在哪|哪個|哪次|哪一次|曾經|曾在|曾|何時|什麼時候|有無|是否|有沒有/g, '')
    .replace(/週會|月會|會議紀錄|會議記錄|會議|會報|委員會|感管會|紀錄|記錄|日期|時間|出現|討論過|討論|議題|清單|相關/g, '')
    .replace(/[?？,，.。:：;；\s]/g, '');
  if (q.length >= 2) return q.slice(0, 30);
  return '';
}

function loadMeetingDocTexts_(scope) {
  const folderId = getProp_('KB_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const docs = [];
  while (files.hasNext() && docs.length < 180) {
    const file = files.next();
    const name = file.getName();
    if (!/\.md$/i.test(name)) continue;
    const isWeekly = /^週會紀錄_檢索記事本/.test(name);
    const isMonthly = /^月會議題_民國/.test(name);
    if (scope === 'weekly' && !isWeekly) continue;
    if (scope === 'monthly' && !isMonthly) continue;
    if (scope === 'all' && !isWeekly && !isMonthly) continue;
    docs.push({ name: name, text: file.getBlob().getDataAsString('UTF-8') });
  }
  return docs;
}

function searchMeetingDocs_(docs, topic, originalQuestion) {
  const topicTokens = meetingTopicTokens_(topic);
  const exactTopic = String(topic || '').replace(/\s+/g, '').toLowerCase();
  const yearMatch = String(originalQuestion || '').match(/(?:民國)?(\d{2,3})年|20\d{2}/);
  const yearFilter = yearMatch ? yearMatch[0].replace(/民國|年/g, '') : '';
  const hits = [];
  const seen = {};

  (docs || []).forEach(function(doc) {
    const kind = /^週會/.test(doc.name) ? '週會' : '月會';
    const lines = String(doc.text || '').split(/\r?\n/);
    lines.forEach(function(raw) {
      const line = cleanMeetingLine_(raw);
      if (!line) return;
      if (yearFilter && line.indexOf(yearFilter) < 0 && doc.name.indexOf(yearFilter) < 0) return;
      const compact = line.replace(/\s+/g, '').toLowerCase();
      const matched = topicTokens.some(function(token) { return compact.indexOf(token) >= 0; });
      if (!matched) return;
      const key = doc.name + '|' + line;
      if (seen[key]) return;
      seen[key] = true;
      const dates = extractIsoDates_(line);
      hits.push({
        kind: kind,
        fileName: doc.name,
        dates: dates,
        summary: summarizeMeetingLine_(line),
        _score: meetingLineScore_(line, compact, exactTopic, dates)
      });
    });
  });
  hits.sort(function(a, b) {
    if (b._score !== a._score) return b._score - a._score;
    return String(a.fileName).localeCompare(String(b.fileName), 'zh-Hant');
  });
  return hits.slice(0, 16);
}

function meetingLineScore_(line, compact, exactTopic, dates) {
  let score = 0;
  if (exactTopic && compact.indexOf(exactTopic) >= 0) score += 80;
  if (exactTopic && compact.indexOf(exactTopic) === 0) score += 80;
  if (dates && dates.length) score += 50 + Math.min(dates.length, 10);
  if (/日期[:：]|月會[:：]/.test(line)) score += 45;
  if (/^20\d{2}-\d{2}-\d{2}/.test(line)) score += 60;
  if (/（\d+筆；日期[:：]/.test(line)) score += 70;
  if (/；特別字眼[:：]/.test(line)) score -= 45;
  if (/分類關鍵詞[:：]/.test(line)) score -= 35;
  if (/主席裁示|已key-in|核章|簽文/.test(line)) score -= 15;
  return score;
}

function meetingTopicTokens_(topic) {
  const compact = String(topic || '').replace(/\s+/g, '').toLowerCase();
  const tokens = {};
  if (compact) tokens[compact] = true;
  tokenize_(topic).forEach(function(token) {
    if (token.length >= 2) tokens[token.replace(/\s+/g, '').toLowerCase()] = true;
  });
  return Object.keys(tokens).slice(0, 20);
}

function cleanMeetingLine_(raw) {
  let line = String(raw || '').trim();
  line = line.replace(/^[-*]\s*/, '').replace(/^#+\s*/, '').trim();
  if (!line) return '';
  if (/分卷|檔案索引|本檔因|請上傳|產生時間|週會紀錄筆數|命中分類數|明細筆數|不重複議題數|命中分類；概略描述/.test(line)) return '';
  if (line.length < 4) return '';
  return line;
}

function extractIsoDates_(text) {
  const seen = {};
  const matches = String(text || '').match(/20\d{2}-\d{2}-\d{2}/g) || [];
  return matches.filter(function(date) {
    if (seen[date]) return false;
    seen[date] = true;
    return true;
  });
}

function summarizeMeetingLine_(line) {
  let s = String(line || '').trim();
  s = s.replace(/；分類關鍵詞：[^；]+/g, '');
  s = s.replace(/；特別字眼：/g, '；特別字眼：');
  s = s.replace(/\s+/g, ' ');
  return s.length > 180 ? s.slice(0, 177) + '...' : s;
}

function smallTalkReply_(question, event) {
  const q = normalizeIntentText_(question);
  if (!q) return '';

  const externalRuleReply = externalIntentRuleReply_(q);
  if (externalRuleReply) return externalRuleReply;

  if (/^(可以查什麼|可以問什麼|你能做什麼|你能查什麼|你能回答什麼|你能答什麼|你可以做什麼|你可以回答什麼|你可以答什麼|你會做什麼|你能幫我什麼|你提供什麼服務|有什麼功能|你現在有什麼在執行的事|你現在在執行什麼|你目前在執行什麼|你現在在做什麼|你目前在做什麼|選單|主選單|目錄|說明|幫助|功能|help|menu|\?|？)$/.test(q)) {
    return '您好，我是台大感管 LINE 查詢助手。可查感染管制、法定傳染病通報、隔離/解隔、檢體送驗、疫區、清消濃度、查核重點，也可查週會/月會議題曾在哪些日期出現。\n\n提問範例：VRE 解隔、登革熱通報、伊波拉疫區、感染月報在哪些週會出現。';
  }
  if (/^(hi|hello|hey|哈囉|嗨|你好|您好|早安|午安|晚安|安安|在嗎|你在嗎|收到嗎)$/.test(q)) {
    return '您好，我在。可以直接問疾病或情境，例如「VRE 解隔」、「登革熱通報」、「透析室清消濃度」，也可以問「感染月報在哪些週會出現」。';
  }
  if (/^(謝謝|謝謝你|感謝|感謝你|謝啦|謝囉|thanks|thankyou|thx|辛苦了|麻煩你了|中秋愉快|新年快樂|過年好)$/.test(q) || /台大感管好棒|你.*(真好|很好|好好|聰明|很棒|不錯|厲害|貼心|親切)/.test(q)) {
    return '謝謝您，我會盡量把資料整理得準確、好讀、可執行。需要時可以直接問通報、隔離/解隔、採檢、清消、疫區或會議紀錄。';
  }
  if (/你不好聊|你難聊|問不出滿意答案|聽不懂|講人話|牛頭馬嘴|亂回答|很笨|答非所問|不滿意/.test(q)) {
    return '抱歉，剛剛沒有切中重點。您可以直接補一句想要的格式，例如「白話一點」、「只列流程」、「補檢體」、「用查核口吻」或「回答短一點」。\n\n也可以用「疾病/議題 + 想問項目」重問，例如：VRE 解隔標準、登革熱隔離醫囑、感染月報在哪些週會出現。';
  }
  if (/你是誰|你會什麼|怎麼用|使用方式/.test(q)) {
    return '我是台大感管 LINE 查詢助手，主要協助查感染管制知識庫、通報流程、隔離醫囑、檢體送驗、清消濃度、國際疫情，以及週會/月會議題檢索。';
  }
  if (/你是男生|你是女生|你男生|你女生|性別|男生嗎|女生嗎|你是帥哥|你是美女|你漂亮嗎|你帥嗎|你長怎樣|外貌/.test(q)) {
    return '我沒有性別或外貌，是台大感管 LINE 查詢助手。比較擅長協助查通報、隔離解隔、清消、疫區、檢體送驗和會議紀錄。';
  }
  if (/你會睡覺|你是24小時|你會死嗎|你吃什麼|你喜歡吃什麼|你喜歡什麼顏色|你會生氣|放屁|上廁所|生寶寶|男朋友|女朋友|交朋友|陪我聊天/.test(q)) {
    return '我不是人，沒有身體、睡眠、食物或感情生活；我是用來查資料和簡單回覆的 LINE 助手。可以簡單聊幾句，但主要任務還是協助感染管制查詢。';
  }
  if (/感管中心.*(辦公室|在哪|位置|怎麼去)|感染管制中心.*(辦公室|在哪|位置|怎麼去)/.test(q)) {
    return '感管中心辦公室在東址研究大樓 7 樓 710 辦公室；可從 7C 病房往 722 病室走廊的防火門進入。';
  }
  if (/(感管中心|感染管制中心).*(幾個人|主任|主管|負責人|人員名單)|王振泰.*(感管|主任|主管)/.test(q)) {
    return '這類人員編制、主任或主管資訊可能異動，我不會從舊文件推測。請以院內通訊錄、正式公告或感管中心最新資訊為準。';
  }
  if (/你們院長|院長好嗎|主任好嗎|主管好嗎|賴清德|蔣萬安|獎萬安|投票|投給誰|政治|政黨|綠色|藍色/.test(q)) {
    return '我不評論個人好壞、政治立場或選舉偏好。這個帳號主要協助感染管制、通報、隔離解隔、清消、疫區與查核重點。';
  }
  if (/[\u4e00-\u9fff]{1,6}.*(很壞|很爛|機車|綠茶婊|討厭|很差)/.test(q)) {
    return '我不評論或附和對特定個人、單位或團體的負面評價。若是具體事件讓您困擾，建議整理時間、地點、發生經過與希望改善的事項，透過正式管道反映。';
  }
  if (/個管師.*(漂亮|親切|很好|很棒)|同仁.*(親切|很好|很棒)/.test(q)) {
    return '謝謝您對院內同仁的肯定。若要回饋服務經驗，建議聚焦在具體協助內容；若有感染管制問題，也可以直接問我。';
  }
  if (/投訴|申訴|抱怨|檢舉|我建議|建議/.test(q)) {
    return '若要反映意見，建議留下不含病人個資的事件重點、時間、地點、流程與希望改善的事項，再依院內正式管道反映。若是感染管制相關問題，也可以把情境簡述給我，我協助整理可確認的流程。';
  }
  if (/想自殺|不想活|想死|撐不下去|撐不住|結束生命|傷害自己/.test(q)) {
    return '聽起來您現在很辛苦。請先不要一個人承受，立刻找身邊可信任的人、主管、同事或醫療人員陪您；若有立即危險，請直接就近急診或撥打當地緊急電話。若在院內，請請同仁或護理站協助您取得即時支持。';
  }
  if (/心情不好|心情低落|低落|難過|想哭|哭泣|哭哭|流淚|沮喪|焦慮|好無聊|想家|想爸媽|過年不想上班/.test(q)) {
    return '辛苦了。可以先讓自己離開壓力現場一下、喝水、深呼吸，或找可信任的人說幾句。若情緒持續影響睡眠、工作或安全，建議主動尋求主管、員工協助資源或醫療協助。';
  }
  if (/台大醫院.*(怎麼去|地址|在哪)|地址|掛哪一科|看哪一科|找哪一科|哪一科|哪位醫師|哪一位醫師|找.*醫師|看.*醫師|醫師推薦|推薦醫師|掛號|看診|就醫|台大醫院app/.test(q)) {
    return '本帳號不提供疾病診斷、醫師推薦、就醫科別、掛號或個案治療建議。請使用台大醫院 App、官方網站或正式掛號諮詢查詢合適科別與醫師。若有呼吸困難、意識改變、持續胸痛、嘴唇發紫或其他急重症警訊，請立即就近急診或撥 119。';
  }
  if (/今天.*(買什麼菜|點飲料|穿外套|塞車)|天氣如何|現在熱|台北房租|房子貴|該買房|我該離職|會戰爭嗎/.test(q)) {
    return '這個問題不屬於感染管制知識庫範圍，我不適合替您判斷。若您想問旅遊疫情、發燒、腹瀉、食物中毒、隔離或通報，請補充情境，我再協助整理。';
  }
  if (/糖尿病.*吃|高血壓.*吃|可以吃|能吃多少|營養|飲食/.test(q)) {
    return '這屬於個人醫療或營養照護問題，我不能只靠 LINE 訊息判斷能不能吃、能吃多少或怎麼調整飲食。\n\n建議請教您的主治醫師、衛教師或營養師，依血糖、血壓、用藥、腎功能與個人狀況評估。若您想問的是感染管制相關問題，例如發燒、腹瀉、食物中毒、隔離或通報，請再補充情境。';
  }
  if (/^(香蕉芭樂|綠茶婊|人死後去哪)$/.test(q)) {
    return '這個問題不屬於感染管制知識庫範圍。若您想查感染管制、通報、隔離解隔、清消、疫區、檢體送驗或會議紀錄，請直接輸入關鍵字。';
  }
  return '';
}

function externalIntentRuleReply_(normalizedQuestion) {
  const rule = externalIntentRule_(normalizedQuestion);
  return rule ? String(rule.reply || '').trim() : '';
}

function externalIntentRule_(normalizedQuestion, category) {
  let rules = [];
  try {
    const kb = loadKb_();
    rules = kb && kb.intent_rules && kb.intent_rules.rules ? kb.intent_rules.rules : [];
  } catch (err) {
    return '';
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] || {};
    if (!rule.pattern || !rule.reply) continue;
    if (category && String(rule.category || '') !== String(category)) continue;
    try {
      const re = new RegExp(String(rule.pattern), rule.flags || '');
      if (re.test(normalizedQuestion)) return rule;
    } catch (err2) {
      console.error('Bad intent rule ' + String(rule.id || i) + ': ' + err2.toString());
    }
  }
  return null;
}

function normalizeIntentText_(text) {
  return convertFullWidthToHalfWidth_(String(text || ''))
    .replace(/\s+/g, '')
    .replace(/[，。！？?！～~、；;：:「」『』"'`]/g, '')
    .toLowerCase();
}

function getLineUserId_(event) {
  return event && event.source && event.source.userId ? String(event.source.userId) : '';
}

function userModeKey_(userId) {
  return 'mode_' + userId;
}

function getUserMode_(event) {
  const userId = getLineUserId_(event);
  if (!userId) return 'clinical';
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(userModeKey_(userId));
    return raw === 'audit' ? 'audit' : 'clinical';
  } catch (err) {
    console.error('getUserMode_ skipped: ' + err.toString());
    return 'clinical';
  }
}

function hasExplicitUserMode_(event) {
  const userId = getLineUserId_(event);
  if (!userId) return false;
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(userModeKey_(userId));
    return raw === 'audit' || raw === 'clinical';
  } catch (err) {
    return false;
  }
}

function saveUserMode_(event, mode) {
  const userId = getLineUserId_(event);
  if (!userId) return;
  try {
    PropertiesService.getScriptProperties().setProperty(userModeKey_(userId), mode === 'audit' ? 'audit' : 'clinical');
  } catch (err) {
    console.error('saveUserMode_ skipped: ' + err.toString());
  }
}

function getUserIdentity_(event) {
  const userId = getLineUserId_(event);
  if (!userId) return '';
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(userStateKey_(userId)) || props.getProperty('state_' + userId) || '';
    if (!raw) return '';
    const state = JSON.parse(raw);
    return state && (state.identity === 'staff' || state.identity === 'public') ? state.identity : '';
  } catch (err) {
    console.error('getUserIdentity_ skipped: ' + err.toString());
    return '';
  }
}

function userStateKey_(userId) {
  return 'user_state_' + String(userId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function getUserState_(userId) {
  if (!userId) return {};
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(userStateKey_(userId)) || props.getProperty('state_' + userId) || '';
    if (!raw) return {};
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : {};
  } catch (err) {
    console.error('getUserState_ skipped: ' + err.toString());
    return {};
  }
}

function saveUserState_(userId, state) {
  if (!userId) return;
  try {
    PropertiesService.getScriptProperties().setProperty(userStateKey_(userId), JSON.stringify(state || {}));
  } catch (err) {
    console.error('saveUserState_ skipped: ' + err.toString());
  }
}

function feedbackResponseReply_(question, event) {
  const userId = getLineUserId_(event);
  if (!userId) return '';
  const q = normalizeIntentText_(question);
  if (isSatisfactionPromptCommand_(q)) {
    const state = getUserState_(userId);
    if (Number(state.validQuestionCount || 0) < 5) {
      const count = Math.max(0, Math.min(5, Number(state.validQuestionCount || 0)));
      return '完成 5 次有效問答後，才會開放滿意度評分與抽獎資格。目前已完成 ' + count + '/5 次。';
    }
    state.qualityPrompted = true;
    state.qualityPromptedAt = new Date().toISOString();
    saveUserState_(userId, state);
    return satisfactionPromptText_();
  }

  const state = getUserState_(userId);
  if (!state.qualityPrompted && !/^(1|2|3|4|5|一|二|三|四|五|非常有幫助|有幫助|部分有幫助|幫助不大|沒有幫助|沒幫助|不滿意|滿意)$/.test(q)) {
    return '';
  }
  const score = detectSatisfactionChoice_(q);
  if (!score) return '';

  state.lastFeedback = score;
  state.lastFeedbackAt = new Date().toISOString();
  state.feedbackCount = Number(state.feedbackCount || 0) + 1;
  state.qualityPrompted = false;
  state.validQuestionCount = 0;
  saveUserState_(userId, state);

  if (score === 'very_good' || score === 'good') {
    const rating = score === 'very_good' ? '滿意度 1 分：非常有幫助' : '滿意度 2 分：有幫助';
    return '已記錄「' + rating + '」。謝謝您的回饋；若之後想補充建議，也可以輸入「感管意見箱」。';
  }
  if (score === 'partial') {
    return '已記錄「滿意度 3 分：部分有幫助」。您也可以直接告訴我希望怎麼改，例如「回答短一點」、「白話一點」或輸入「感管意見箱」。';
  }
  const rating = score === 'slightly_bad' ? '滿意度 4 分：幫助不大' : '滿意度 5 分：沒有幫助';
  return '已記錄「' + rating + '」。謝謝您提醒；您可以補一句希望的方向，或輸入「感管意見箱」留下具體建議。';
}

function isSatisfactionPromptCommand_(question) {
  const q = normalizeIntentText_(question);
  return /^(🔒滿意度|滿意度|我要回饋|回饋|意見回饋|填滿意度|品質回饋|品質蒐集|問卷|評分)$/.test(q);
}

function isSatisfactionEligible_(event) {
  const userId = getLineUserId_(event);
  if (!userId) return false;
  const state = getUserState_(userId);
  return Number(state.validQuestionCount || 0) >= 5;
}

function detectSatisfactionChoice_(normalizedQuestion) {
  const q = String(normalizedQuestion || '').trim().replace(/^滿意度/, '');
  if (/^(1|一|非常有幫助|非常滿意|非常有用|很好|非常好)$/.test(q)) return 'very_good';
  if (/^(2|二|有幫助|有用|滿意|不錯|ok|good)$/.test(q)) return 'good';
  if (/^(3|三|部分有幫助|部分有用|普通|還好|一半)$/.test(q)) return 'partial';
  if (/^(4|四|幫助不大|不太有用|不太滿意)$/.test(q)) return 'slightly_bad';
  if (/^(5|五|沒有幫助|沒幫助|沒用|不滿意|答非所問|完全沒用)$/.test(q)) return 'bad';
  return '';
}

function satisfactionPromptText_() {
  return '【滿意度調查｜非醫療處置選項】\n以下評分是針對問答工具，不是病人處置選項：\n1 非常有幫助\n2 有幫助\n3 部分有幫助\n4 幫助不大\n5 沒有幫助\n\n請點下方「滿意度」按鈕，或輸入「感管意見箱」留下建議。';
}

function suggestionBoxReply_(question, event) {
  const userId = getLineUserId_(event);
  if (!userId) return '';
  const q = String(question || '').trim();
  const compact = normalizeIntentText_(q);
  const state = getUserState_(userId);

  if (/^(查意見箱|意見箱紀錄|最新意見|看意見|意見紀錄|意見列表)$/.test(compact)) {
    return 'LINE 意見箱僅供投稿；意見內容不會透過 LINE 對話提供。';
  }

  if (state.inSuggestionBox) {
    const setAt = new Date(state.inSuggestionBoxAt || 0).getTime();
    const expired = Date.now() - setAt > 5 * 60 * 1000;
    if (expired || isLikelyClinicalQuestion_(q)) {
      state.inSuggestionBox = false;
      saveUserState_(userId, state);
      return '';
    }
    if (/^(取消|退出|算了|返回|不寫了)$/.test(compact)) {
      state.inSuggestionBox = false;
      saveUserState_(userId, state);
      return '已取消意見投遞。若有感染管制問題，可以直接輸入疾病或情境查詢。';
    }
    saveSuggestionRecord_(q, userId, state.identity || getUserIdentity_(event) || '未設定');
    state.inSuggestionBox = false;
    state.suggestionCount = Number(state.suggestionCount || 0) + 1;
    saveUserState_(userId, state);
    return '已收到您的意見，謝謝協助改善感管 LINE 問答。若還有要補充的內容，可以再輸入「感管意見箱」。';
  }

  if (/^(感管意見箱|意見箱|寫意見|反映意見|感管建議|提供建議|投遞意見|我要反映|我要建議)$/.test(compact)) {
    state.inSuggestionBox = true;
    state.inSuggestionBoxAt = new Date().toISOString();
    saveUserState_(userId, state);
    return '請直接輸入想反映的建議或問題，不要包含病人姓名、病歷號、床號或可識別個資。\n\n若要取消，請輸入「取消」。';
  }

  return '';
}

function isLikelyClinicalQuestion_(question) {
  const q = String(question || '');
  return /疫區|旅遊疫情|通報|診斷|醫囑|採檢|送驗|檢體|隔離|解隔|清消|消毒|漂白水|PPE|防護|病人安置|床位|病房|造冊|暴露|發燒|咳嗽|腹瀉|皮疹|VRE|CRE|MRSA|MRSE|CRAB|CRPA|MDRO|KP|Klebsiella|麻疹|德麻|德國麻疹|腮腺炎|百日咳|登革熱|伊波拉|伊坡拉|流感|新冠|疥瘡|結核|立百|退伍軍人|兔熱病|日腦|日本腦炎|流腦|流行性腦脊髓膜炎|Hib|IPD|M痘|猴痘|SFTS|A肝|B肝|C肝|E肝|梅毒|淋病|恙蟲|萊姆|內視鏡|透析/i.test(q);
}

function getSuggestionRecords_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('SUGGESTION_RECORDS') || '[]';
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('getSuggestionRecords_ skipped: ' + err.toString());
    return [];
  }
}

function saveSuggestionRecord_(text, userId, identity) {
  try {
    const list = getSuggestionRecords_();
    list.unshift({
      time: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm'),
      userHash: Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(userId || ''))).slice(0, 16),
      identity: identity || '未設定',
      text: String(text || '').slice(0, 800)
    });
    PropertiesService.getScriptProperties().setProperty('SUGGESTION_RECORDS', JSON.stringify(list.slice(0, 100)));
  } catch (err) {
    console.error('saveSuggestionRecord_ skipped: ' + err.toString());
  }
}

function isLowValueOrMetaQuestion_(question) {
  const q = normalizeIntentText_(question);
  if (!q) return true;
  if (/^(可以查什麼|可以問什麼|你能做什麼|你能查什麼|你能回答什麼|你能答什麼|你可以做什麼|你可以回答什麼|你可以答什麼|你會做什麼|你能幫我什麼|你提供什麼服務|有什麼功能|你現在有什麼在執行的事|你現在在執行什麼|你目前在執行什麼|你現在在做什麼|你目前在做什麼|選單|主選單|目錄|說明|幫助|功能|help|menu)$/.test(q)) return true;
  if (/你是男生|你是女生|你會睡覺|你吃什麼|你喜歡|你不好聊|你難聊|講人話|問不出滿意答案|香蕉芭樂|綠茶婊|投票|政治/.test(q)) return true;
  if (/今天.*(買什麼菜|點飲料|穿外套|塞車)|天氣如何|現在熱|台北房租|房子貴|該買房|我該離職|會戰爭嗎/.test(q)) return true;
  return false;
}

function isCdcn0146Query_(question) {
  const q = convertFullWidthToHalfWidth_(String(question || ''));
  return /CDCN0146|接觸者醫令|接觸者採檢醫令|接觸者送驗醫令|接觸者篩檢醫令/i.test(q);
}

function isKpLabResultQuery_(question) {
  const q = convertFullWidthToHalfWidth_(String(question || ''));
  const hasKp = /\bK\.?\s*P\.?\b|Klebsiella\s*pneumoniae|肺炎克雷伯|肺炎克雷白|肺克|克雷伯菌/i.test(q);
  if (!hasKp) return false;
  return /檢驗|檢出|驗出|培養|報告|長出|分離出|菌|痰|尿|血|傷口|引流|移生|感染|隔離|醫囑|處置/i.test(q);
}

function kpLabResultReply_() {
  return '檢驗出 KP 時，先不要直接等同於 CRE 或一定要接觸隔離。\n\n' +
    'KP 通常指 Klebsiella pneumoniae，也就是肺炎克雷伯菌。處理時請先看檢驗報告的抗生素感受性與是否被標示為 CRKP、CRE、CPE、KPC、NDM，或 carbapenem 類抗生素抗藥。\n\n' +
    '臨床可先這樣判斷：\n' +
    '- 若只是一般 KP，未顯示重要抗藥性：依標準防護與病人感染部位照護，不要自行貼抗藥菌標籤。\n' +
    '- 若報告為 CRKP、CRE、CPE、KPC、NDM 或 carbapenem-resistant：依 CRE/抗藥菌接觸隔離流程處理，確認隔離醫囑、病人安置、檢查轉送通知與終期清潔。\n' +
    '- 若不確定是不是抗藥菌：請先查藥敏結果，或詢問檢驗醫學部/感染管制中心，不要只憑 KP 三個字判定。\n\n' +
    '院內提醒：MDRO/CRE 這類抗藥菌檢體是送本院檢醫部，不是送 CDC 防疫檢體。若需主動篩檢或解隔評估，診療醫令可走主分類「細菌」、次分類「感管篩選」，再依菌種與採檢部位選擇醫令。';
}

function cdcn0146Reply_() {
  return '⚠️ **【重點強調】HIS 防疫檢體醫令：`CDCN0146`（百日咳接觸者專用採檢醫令）**：\n\n' +
    '1. **使用對象與開單說明**：\n' +
    '   · **`CDCN0146`** 為專用於**「百日咳接觸者 (Contacts) / 匡列暴露人員 / 暴露同仁」**之採檢送驗醫令。\n' +
    '   · **與指標個案分流**：若為百日咳指標個案/確診通報者，請開立 **`CDCN0038`**；若為**匡列接觸者/暴露同仁**，特別強調務必開立 **`CDCN0146`**，切勿誤開為指標個案通報醫令！\n\n' +
    '2. **HIS 系統開單路徑**：\n' +
    '   · 登入 HIS 系統 ➔ 進入「診療醫令」 ➔ 主分類「檢驗」 ➔ 次分類「CDC防疫檢體」 ➔ 搜尋並選擇 **`CDCN0146 接觸者採檢`**。' +
    nextSubtopicPrompt_('百日咳');
}

function isPostExposurePepQuery_(question) {
  const q = convertFullWidthToHalfWidth_(String(question || ''));
  return /暴露.*(造冊|預防|投藥|PEP|用藥|追蹤|處置)|(造冊原則|預防用藥|預防性投藥|PEP|暴露處置|接觸者造冊|接觸者名單|暴露後)/i.test(q);
}

function postExposurePepReply_(question) {
  const q = convertFullWidthToHalfWidth_(String(question || ''));

  if (/百日咳/i.test(q)) {
    return '🧪 **百日咳 暴露後接觸者造冊原則與預防用藥 (PEP)**：\n\n' +
      '1. **接觸者匡列與造冊原則**：\n' +
      '   · **匡列對象**：確診個案發病前 21 天至接受有效抗生素治療滿 5 天（或發病後 21 天）內之同住家人、同班同學、同病室/同車空間長時間近距離接觸者、及無適當防護照顧之醫護同仁。\n' +
      '   · **健康監測**：匡列對象須進行自主健康監測 **21 天**（自最後接觸日起算）。\n\n' +
      '2. **預防性投藥 (PEP)**：\n' +
      '   · **給藥時機**：無論有無症狀，密集接觸者均建議儘速給予預防性投藥（於最後接觸 21 天內給予）。\n' +
      '   · **建議用藥**：口服 **Azithromycin** (成人 500mg Day 1，250mg Day 2-5) 或 **Erythromycin** (500mg QID 共 7-14 天)。\n\n' +
      '3. ⚠️ **【關鍵強調】百日咳接觸者採檢醫令 `CDCN0146`**：\n' +
      '   · 匡列接觸者與暴露同仁進行鼻咽拭子/抽吸液採檢時，**特別強調務必開立 `CDCN0146`（接觸者採檢醫令）**，切勿與指標個案 (Index Case) 通報醫令 (`CDCN0038`) 混淆！\n' +
      nextSubtopicPrompt_('百日咳');
  }

  if (/麻疹/i.test(q)) {
    return '🔴 **麻疹 暴露後接觸者造冊原則與預防處置 (PEP)**：\n\n' +
      '1. **接觸者匡列與造冊原則**：\n' +
      '   · **匡列時段**：指標個案 **出疹前 4 天至出疹後 4 天**（可傳染期）。\n' +
      '   · **匡列對象**：同住家人、同病室/同車/共處一室或同動線之接觸者，及無適當防護近距離照護之醫護同仁。\n' +
      '   · **自主健康管理**：匡列對象須進行健康監測 **18 至 21 天**（自最後接觸日起算，每日量測體溫與發疹監測）。\n\n' +
      '2. **預防性處置 (PEP)**：\n' +
      '   · **MMR 疫苗**：暴露後 **72 小時內** 接種 1 劑 MMR 疫苗（適用 6 個月以上無麻疹免疫力者）。\n' +
      '   · **免疫球蛋白 (IVIG/IMIG)**：暴露後 **6 天內** 給予肌肉/靜脈注射免疫球蛋白（適用 6 個月以下嬰兒、孕婦及免疫功能障礙者）。\n\n' +
      '3. **採檢與通報醫令**：\n' +
      '   · 匡列接觸者與暴露同仁採檢請開立 HIS「`CDCN0122` 麻疹檢體送驗醫令」送檢。\n' +
      nextSubtopicPrompt_('麻疹');
  }

  return '💉 **針扎與血液體液暴露 (HIV/HBV/HCV) 處置與 PEP**：\n\n' +
    '1. **現場立即處置**：\n' +
    '   · 傷口：擠出血液並以流動清水與肥皂沖洗洗淨。\n' +
    '   · 黏膜：以大量生理食鹽水沖洗。\n\n' +
    '2. **開單採檢與通報**：\n' +
    '   · 開立 HIS「針扎/血液體液暴露檢驗套單」（含 HIV, Anti-HBs, HBsAg, Anti-HCV, VDRL）。\n' +
    '   · 24 小時內登入院內系統完成針扎通報。\n\n' +
    '3. **預防性投藥 (PEP)**：\n' +
    '   · **HIV PEP**：高風險暴露需於 **2 小時內（最遲 72 小時內）** 啟動 PEP 3 藥聯用，連續服用 28 天。\n' +
    '   · **HBV PEP**：依 Source 與暴露者抗體狀態，必要時於 24 小時內施打 HBIG 免疫球蛋白及補打 HBV 疫苗。\n' +
    nextSubtopicPrompt_('針扎與體液暴露');
}

function detectDisease_(question) {
  const q = String(question || '').toLowerCase();

  // 1. MDRO
  if (/vre|抗萬古黴素腸球菌/i.test(q)) return { name: 'VRE', key: 'VRE' };
  if (/cre|cpe|抗藥性腸桿菌/i.test(q)) return { name: 'CRE', key: 'CRE' };
  if (/mrse|抗藥性表皮葡萄球菌|表皮葡萄球菌/i.test(q)) return { name: 'MRSE', key: 'MRSE' };
  if (/mrsa|抗藥性金黃色葡萄球菌/i.test(q)) return { name: 'MRSA', key: 'MRSA' };
  if (/crab|mdrab/i.test(q)) return { name: 'CRAB', key: 'CRAB' };
  if (/crpa|mdrpa/i.test(q)) return { name: 'CRPA', key: 'CRPA' };
  if (/耳念珠菌|candida\s*auris/i.test(q)) return { name: '耳念珠菌', key: '耳念珠菌' };
  if (/mdro|多重抗藥菌|抗藥菌/i.test(q)) return { name: 'MDRO', key: 'MDRO' };

  // 2. 呼吸道與法定傳染病
  if (/兔熱/i.test(q)) return { name: '兔熱病', key: '兔熱病' };
  if (/黃熱/i.test(q)) return { name: '黃熱病', key: '黃熱病' };
  if (/q熱/i.test(q)) return { name: 'Q熱', key: 'Q熱' };
  if (/日腦|日本腦炎|jev\b|japanese\s+encephalitis/i.test(q)) return { name: '日本腦炎', key: '日本腦炎' };
  if (/德麻|德國麻疹|rubella/i.test(q)) return { name: '德國麻疹', key: '德國麻疹' };
  if (/麻疹/i.test(q)) return { name: '麻疹', key: '麻疹' };
  if (/腮腺炎|mumps/i.test(q)) return { name: '流行性腮腺炎', key: '流行性腮腺炎' };
  if (/百日咳/i.test(q)) return { name: '百日咳', key: '百日咳' };
  if (/登革/i.test(q)) return { name: '登革熱', key: '登革熱' };
  if (/新型\s*a\s*型流感|新\s*a\s*流感|禽流感|h5n1|h7n9|h5n6|h9n2/i.test(q)) return { name: '新型A型流感', key: '新型A型流感' };
  if (/(^|[^新型])(?:a流|b流|a型流感|b型流感|流感a|流感b|influenza\s*a|influenza\s*b)/i.test(q)) return { name: '流感', key: '流感' };
  if (/流感/i.test(q)) return { name: '流感', key: '流感' };
  if (/新冠|covid/i.test(q)) return { name: '新冠', key: '新冠' };
  if (/帶狀[疱皰]疹/i.test(q)) return { name: '帶狀疱疹', key: '帶狀疱疹' };
  if (/水痘/i.test(q)) return { name: '水痘', key: '水痘' };
  if (/結核|tb/i.test(q)) return { name: '結核', key: '結核' };
  if (/困難梭菌|c\.?\s*diff/i.test(q)) return { name: 'C. difficile', key: 'C. difficile' };
  if (/庫賈氏|cjd/i.test(q)) return { name: '庫賈氏病', key: '庫賈氏病' };
  if (/伊波拉|伊坡拉|ebola/i.test(q)) return { name: '伊波拉', key: '伊波拉' };
  if (/腸病毒/i.test(q)) return { name: '腸病毒', key: '腸病毒' };
  if (/疥瘡/i.test(q)) return { name: '疥瘡', key: '疥瘡' };
  if (/瘧疾/i.test(q)) return { name: '瘧疾', key: '瘧疾' };
  if (/狂犬/i.test(q)) return { name: '狂犬病', key: '狂犬病' };
  if (/破傷風/i.test(q)) return { name: '破傷風', key: '破傷風' };
  if (/白喉/i.test(q)) return { name: '白喉', key: '白喉' };
  if (/屈公/i.test(q)) return { name: '屈公病', key: '屈公病' };
  if (/茲卡/i.test(q)) return { name: '茲卡', key: '茲卡' };
  if (/傷寒/i.test(q) && !/副傷寒|斑疹傷寒/.test(q)) return { name: '傷寒', key: '傷寒' };
  if (/副傷寒/i.test(q)) return { name: '副傷寒', key: '副傷寒' };
  if (/斑疹傷寒/i.test(q)) return { name: '斑疹傷寒', key: '斑疹傷寒' };
  if (/桿菌性痢疾/i.test(q)) return { name: '桿菌性痢疾', key: '桿菌性痢疾' };
  if (/阿米巴/i.test(q)) return { name: '阿米巴痢疾', key: '阿米巴痢疾' };
  if (/霍亂/i.test(q)) return { name: '霍亂', key: '霍亂' };
  if (/流行性腦脊髓膜炎|流行性腦膜炎|流腦|meningococcal|meningitis/i.test(q)) return { name: '流行性腦脊髓膜炎', key: '流行性腦脊髓膜炎' };
  if (/\bhib\b|侵襲性\s*b\s*型嗜血|b型嗜血桿菌/i.test(q)) return { name: '侵襲性b型嗜血桿菌感染症', key: '侵襲性b型嗜血桿菌感染症' };
  if (/\bipd\b|侵襲性肺炎鏈球菌|肺炎鏈球菌感染症/i.test(q)) return { name: '侵襲性肺炎鏈球菌感染症', key: '侵襲性肺炎鏈球菌感染症' };
  if (/炭疽/i.test(q)) return { name: '炭疽', key: '炭疽' };
  if (/鼠疫/i.test(q)) return { name: '鼠疫', key: '鼠疫' };
  if (/天花/i.test(q)) return { name: '天花', key: '天花' };
  if (/類鼻疽/i.test(q)) return { name: '類鼻疽', key: '類鼻疽' };
  if (/鉤端螺旋體|鉤端/i.test(q)) return { name: '鉤端螺旋體', key: '鉤端螺旋體' };
  if (/立百/i.test(q)) return { name: '立百病毒', key: '立百病毒' };
  if (/馬堡/i.test(q)) return { name: '馬堡病毒', key: '馬堡病毒' };
  if (/拉薩/i.test(q)) return { name: '拉薩熱', key: '拉薩熱' };
  if (/漢他/i.test(q)) return { name: '漢他病毒', key: '漢他病毒' };
  if (/退伍軍人/i.test(q)) return { name: '退伍軍人病', key: '退伍軍人病' };
  if (/猴痘|m痘|mpox/i.test(q)) return { name: 'M痘', key: 'M痘' };
  if (/sfts|發熱伴血小板減少/i.test(q)) return { name: '發熱伴血小板減少綜合症', key: '發熱伴血小板減少綜合症' };
  if (/a肝|hav|a型肝炎/i.test(q)) return { name: '急性A型肝炎', key: '急性A型肝炎' };
  if (/b肝|hbv|b型肝炎/i.test(q)) return { name: '急性B型肝炎', key: '急性B型肝炎' };
  if (/c肝|hcv|c型肝炎/i.test(q)) return { name: '急性病毒性C型肝炎', key: '急性病毒性C型肝炎' };
  if (/e肝|hev|e型肝炎/i.test(q)) return { name: '急性E型肝炎', key: '急性E型肝炎' };
  if (/未定型肝炎|肝炎未定型|未定型.*肝炎|急性病毒性肝炎未定型/i.test(q)) return { name: '急性病毒性肝炎未定型', key: '急性病毒性肝炎未定型' };
  if (/梅毒|syphilis/i.test(q)) return { name: '梅毒', key: '梅毒' };
  if (/淋病|gonorrhea/i.test(q)) return { name: '淋病', key: '淋病' };
  if (/恙蟲|tsutsugamushi|scrub\s+typhus/i.test(q)) return { name: '恙蟲病', key: '恙蟲病' };
  if (/萊姆|lyme/i.test(q)) return { name: '萊姆病', key: '萊姆病' };
  if (/hiv|愛滋/i.test(q)) return { name: 'HIV', key: 'HIV' };

  const fromSynonyms = detectDiseaseFromSynonyms_(q);
  if (fromSynonyms) return fromSynonyms;

  return null;
}

function detectDiseaseFromSynonyms_(question) {
  try {
    const kb = loadKb_();
    const synonyms = kb && kb.synonyms ? kb.synonyms : {};
    const compact = compactAliasText_(question);
    const keys = Object.keys(synonyms || {});
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!isDiseaseSynonymKey_(key)) continue;
      const terms = [key].concat(synonyms[key] || []);
      for (let j = 0; j < terms.length; j++) {
        if (aliasTermMatches_(compact, terms[j])) return { name: key, key: key };
      }
    }
  } catch (err) {
    console.error('detectDiseaseFromSynonyms_ skipped: ' + err.toString());
  }
  return null;
}

function detectSubtopic_(question) {
  const q = String(question || '');
  if (/通報定義|病例定義|診斷要件|診斷條件|符合通報|要不要通報/i.test(q)) return 'definition';
  if (/解隔|解除隔離|取消隔離|何時解隔|什麼時候解隔|停止隔離/i.test(q)) return 'clearance';
  if (/暴露|造冊|接觸者|PEP|預防用藥|預防性投藥/i.test(q)) return 'exposure';
  if (/安置|床位|病房|負壓|單人|收治/i.test(q)) return 'placement';
  if (/通報|醫令|開單|代碼|診斷碼/i.test(q)) return 'order';
  if (/採檢|送驗|檢體|拭子|抽吸/i.test(q)) return 'specimen';
  if (/隔離|接觸隔離|空氣隔離|飛沫隔離/i.test(q)) return 'isolation';
  if (/清消|消毒|清潔|漂白水|環境/i.test(q)) return 'sanitization';
  if (/照護|處置|防護|ppe/i.test(q)) return 'care';
  return null;
}

function influenzaDiscordantTestReply_(question) {
  const q = String(question || '').replace(/\s+/g, '');
  const isInfluenza = /流感|influenza|flu/i.test(q);
  const rapidPositive = /(?:快篩|抗原)(?:檢驗)?(?:為|呈現?|結果)?陽性|陽性(?:的)?(?:流感)?(?:快篩|抗原)/i.test(q);
  const pcrNegative = /(?:pcr|核酸)(?:檢驗)?(?:為|呈現?|結果)?陰性|陰性(?:的)?(?:流感)?(?:pcr|核酸)/i.test(q);
  if (!isInfluenza || !rapidPositive || !pcrNegative) return '';

  const hasSymptoms = /有類流感症狀|有症狀|發燒|咳嗽|喉嚨痛|肌肉痠痛/i.test(q) && !/無症狀|沒有症狀|無類流感症狀/i.test(q);
  const noSymptoms = /無症狀|沒有症狀|無類流感症狀/i.test(q);
  const hasCovidContact = /新冠(?:的)?接觸者|有新冠接觸|有接觸/i.test(q) && !/不是新冠接觸者|無新冠接觸|沒有新冠接觸|無接觸/i.test(q);
  const noCovidContact = /不是新冠接觸者|無新冠接觸|沒有新冠接觸|無接觸/i.test(q);

  if (!(hasSymptoms || noSymptoms) || !(hasCovidContact || noCovidContact)) {
    return '流感快篩陽性、PCR 陰性，需再確認兩項風險：\n' +
      '1. 是否有發燒、咳嗽、喉嚨痛或肌肉痠痛等類流感症狀？\n' +
      '2. 是否為新冠接觸者？\n' +
      '請點選下方符合的組合；新冠接觸者即使無症狀，仍先採較高規格因應。';
  }

  if (hasCovidContact) {
    if (hasSymptoms) {
      return '有類流感症狀且為新冠接觸者：\n' +
        '- 採較高規格呼吸道隔離防護；優先單人安置（或 cohorting 同室隔離），僅可與相同暴露風險者同室，不得與無風險者同室。\n' +
        '- 同步依院內 COVID-19 風險情境流程安排 PPE、新冠及其他呼吸道病原採檢與症狀監測。\n' +
        '- 未完成新冠風險評估前，不因流感 PCR 陰性直接解隔。';
    }
    return '無症狀但為新冠接觸者：仍屬高風險，先採較高規格因應。\n' +
      '- 優先單人安置（或 cohorting 同室隔離），僅可與相同暴露風險的接觸者同室，不得與無風險者同室，以避免後續發病造成第二波散播。\n' +
      '- 依院內 COVID-19 風險情境流程執行 PPE、健康監測及適時採檢；若出現症狀，立即提升為症狀個案處置。\n' +
      '- 未完成新冠風險評估前，不因流感 PCR 陰性直接解隔。';
  }
  if (hasSymptoms) {
    return '有類流感症狀、無新冠接觸史：\n' +
      '- 先維持 ANN00039 飛沫＋接觸隔離。\n' +
      '- 依症狀、採檢時機與檢體品質評估是否重採；確認不支持流感後，再評估以 ANN10039 取消隔離。';
  }
  return '無類流感症狀、無新冠接觸史：\n' +
    '- 若 PCR 採檢時機與檢體品質可信，可由醫療團隊評估不再維持流感隔離；需要取消時開立 ANN10039。\n' +
    '- 若涉及群聚或採檢品質有疑慮，仍先維持防護並洽感管中心／檢驗醫學部評估。';
}

function needsInfluenzaDiscordantRiskClarification_(question) {
  const q = String(question || '').replace(/\s+/g, '');
  const hasSymptomStatus = /有類流感症狀|有症狀|發燒|咳嗽|喉嚨痛|肌肉痠痛|無症狀|沒有症狀|無類流感症狀/i.test(q);
  const hasContactStatus = /新冠(?:的)?接觸者|有新冠接觸|有接觸|不是新冠接觸者|無新冠接觸|沒有新冠接觸|無接觸/i.test(q);
  return !(hasSymptomStatus && hasContactStatus);
}

function isSeasonalInfluenzaClearanceQuestion_(question) {
  const q = String(question || '');
  if (!/流感/i.test(q) || /新型\s*A|禽流感|H5N1|H7N9/i.test(q)) return false;
  return /解隔|解除隔離|取消隔離|解隔天數|是否要陰性|要不要陰性|需不需要陰性/i.test(q);
}

function influenzaClearanceReply_() {
  return '流感解除隔離重點：\n' +
    '- 不建議只用固定天數判斷，也不要求一律驗到陰性；應綜合評估症狀是否改善及是否退燒。\n' +
    '- 同時確認咳嗽與呼吸道分泌物是否可控制、病人能否全程戴口罩，以及是否仍需插管、開放式抽痰、噴霧或 NIV 等氣膠處置。\n' +
    '- 兒童、免疫功能低下、症狀仍明顯或同室病人屬高風險者，可能排病毒較久，先維持飛沫＋接觸隔離並由醫療團隊／感管中心評估。\n' +
    '- 符合解隔條件後開立 ANN10039 取消流感隔離註記；不是終止原本的 ANN00039。';
}

function zosterClearanceReply_() {
  return '帶狀疱疹解除隔離重點：\n' +
    '- 侷限性且免疫功能正常：病灶應完整覆蓋並採接觸防護，維持至所有水泡乾燥結痂。\n' +
    '- 瀰漫性帶狀疱疹，或免疫功能低下且尚未排除瀰漫性感染：採空氣＋接觸隔離，維持至所有病灶乾燥結痂且沒有新病灶。\n' +
    '- 符合條件後開立 ANN10042 取消隔離註記；不是終止原本的隔離醫囑。';
}

function disseminatedZosterDefinitionReply_() {
  return '瀰漫性帶狀疱疹定義：\n' +
    '- 院內定義：帶狀疱疹病灶侵犯 3 個神經節（含）以上。\n' +
    '- 符合院內定義，或免疫功能低下且尚無法排除瀰漫性感染時，先採空氣＋接觸隔離，優先單人負壓病室，至所有病灶乾燥結痂。\n' +
    '- 若病灶分布不典型，需由醫療團隊依全身皮膚檢查、免疫狀態及必要的 VZV 檢驗確認。';
}

function diseaseTestResultIsolationReply_(question, disease) {
  if (!disease) return '';
  const q = String(question || '').replace(/\s+/g, '');
  const hasPositiveResult = /陽性|檢出|驗出|培養出|positive/i.test(q);
  const asksIsolation = /要不要隔離|是否隔離|需要隔離|需不需要隔離|隔離嗎|怎麼隔離|隔離/i.test(q);
  if (!hasPositiveResult || (!asksIsolation && !/(快篩|抗原|pcr|核酸|培養)/i.test(q))) return '';

  const profile = diseaseInfectionControlProfile_(disease.name);
  if (!profile) return '';
  const placement = String(profile.placement || '').trim();
  const order = String(profile.order || '').trim();
  if (!placement && !order) return '';

  let text = disease.name + '檢驗陽性：';
  if (placement) text += '\n- 隔離判斷：' + placement;
  if (order) text += '\n- 院內醫囑：' + order;
  text += '\n- 若後續確認檢驗陰性、結果互相矛盾，或臨床認為可能是假陽性，不要直接沿用本回答；應依確認檢驗、症狀、採檢品質及群聚風險重新評估。';
  return text;
}

function isTravelEpidemicQuery_(question) {
  const q = String(question || '');
  return /疫區|旅遊疫情|疫情建議|哪些國家|哪些地區|哪裡流行|有何疫情|有何特殊傳染病|有哪些疫情/i.test(q);
}

function travelEpidemicReply_(question, disease) {
  if (!disease) return '';
  const diseaseName = disease.name;
  const epidemicName = epidemicDiseaseName_(diseaseName);
  if (!epidemicName) return '';

  try {
    const kb = loadKb_();
    const entries = kb.entries || [];
    const relevant = entries.filter(function(entry) {
      return String(entry.source || '') === 'CDC目前國際旅遊疫情建議等級_疾病疫區.md' &&
        String(entry.title || '').indexOf(epidemicName) >= 0;
    });
    const summary = relevant.filter(function(entry) {
      return /疫區摘要/.test(String(entry.title || ''));
    })[0];
    const detail = relevant.filter(function(entry) {
      return /第[一二三]級|警告|警示|注意|Warning|Alert|Watch/.test(String(entry.title || ''));
    })[0];
    const header = relevant.filter(function(entry) {
      return /目前疫區/.test(String(entry.title || ''));
    })[0];

    if (!summary && !detail && !header) return '';

    const lines = [];
    lines.push(epidemicName + '目前疫區：');
    if (header) {
      cleanEpidemicLines_(header.text).forEach(function(line) { lines.push(line); });
    }
    if (summary) {
      cleanEpidemicLines_(summary.text).forEach(function(line) { lines.push(line); });
    }
    if (detail) {
      cleanEpidemicLines_(detail.text).forEach(function(line) { lines.push(line); });
    }
    lines.push('疫區與旅遊建議會變動；出國前、TOCC 判讀或個案處置時，仍請再確認疾管署最新公告。');
    return normalizeTravelLevelText_(dedupeLines_(lines).join('\n'));
  } catch (err) {
    console.error('travelEpidemicReply_ skipped: ' + err.toString());
    return '';
  }
}

function countryOrRegionEpidemicReply_(question) {
  const q = String(question || '').trim();
  if (!isTravelEpidemicQuery_(q) && !/(非洲|東南亞|奈及利亞|烏干達|印度|剛果|中國|日本|韓國|泰國|越南|印尼|菲律賓|馬來西亞|新加坡|柬埔寨|緬甸|寮國)/.test(q)) return '';
  const target = extractEpidemicPlace_(q);
  if (!target) return '';

  try {
    const kb = loadKb_();
    const entries = kb.entries || [];
    const hits = [];
    const seen = {};
    entries.forEach(function(entry) {
      if (String(entry.source || '') !== 'CDC目前國際旅遊疫情建議等級_疾病疫區.md') return;
      const title = String(entry.title || '');
      const text = String(entry.text || '');
      if (/疫區摘要/.test(title)) return;
      if (!/第[一二三]級|警告|警示|注意|Warning|Alert|Watch/.test(title)) return;
      if (!epidemicPlaceMatches_(title + '\n' + text, target)) return;

      const diseaseName = title.replace(/\s+(疫區摘要|第[一二三]級[:：].*)$/, '').trim();
      const level = epidemicLevelFromText_(title + '\n' + text);
      const date = epidemicDateForPlace_(text, target);
      const key = diseaseName + '|' + level;
      if (!diseaseName || seen[key]) return;
      seen[key] = true;
      hits.push({ diseaseName: diseaseName, level: level, date: date });
    });

    if (!hits.length) return '';
    hits.sort(function(a, b) {
      return epidemicLevelRank_(b.level) - epidemicLevelRank_(a.level) ||
        String(a.diseaseName).localeCompare(String(b.diseaseName), 'zh-Hant');
    });
    const lines = [];
    lines.push(target.label + '目前列示的旅遊疫情：');
    hits.slice(0, 12).forEach(function(hit) {
      lines.push('- ' + hit.diseaseName + '：' + (hit.level || '旅遊疫情建議') + (hit.date ? '；發布日期：' + hit.date : ''));
    });
    lines.push('疫情建議等級會隨疾管署公告更新；用於旅遊史、TOCC、通報或個案處置時，請再確認最新公告。');
    return normalizeTravelLevelText_(lines.join('\n'));
  } catch (err) {
    console.error('countryOrRegionEpidemicReply_ skipped: ' + err.toString());
    return '';
  }
}

function extractEpidemicPlace_(question) {
  const q = String(question || '');
  const places = [
    { label: '奈及利亞', terms: ['奈及利亞', '奈及', 'Nigeria'] },
    { label: '烏干達', terms: ['烏干達', 'Uganda'] },
    { label: '印度', terms: ['印度', 'India'] },
    { label: '剛果民主共和國', terms: ['剛果民主共和國', '剛果', 'Congo'] },
    { label: '東南亞', terms: ['東南亞'], region: ['泰國', '越南', '印尼', '菲律賓', '馬來西亞', '新加坡', '柬埔寨', '緬甸', '寮國'] },
    { label: '非洲', terms: ['非洲'], region: ['奈及利亞', '烏干達', '剛果民主共和國', '剛果共和國', '南非', '肯亞', '衣索比亞', '蘇丹', '南蘇丹', '加納', '馬達加斯加'] }
  ];
  for (let i = 0; i < places.length; i++) {
    if (places[i].terms.some(function(term) { return q.indexOf(term) >= 0; })) return places[i];
  }
  return null;
}

function epidemicPlaceMatches_(text, target) {
  const hay = String(text || '');
  const terms = (target.terms || []).concat(target.region || []);
  return terms.some(function(term) { return hay.indexOf(term) >= 0; });
}

function epidemicLevelFromText_(text) {
  const t = normalizeTravelLevelText_(String(text || ''));
  if (/🔴\s*第三級：警告|第三級[:：]警告/.test(t)) return '🔴 第三級：警告';
  if (/🟠\s*第二級：警示|第二級[:：]警示/.test(t)) return '🟠 第二級：警示';
  if (/🟡\s*第一級：注意|第一級[:：]注意/.test(t)) return '🟡 第一級：注意';
  return '';
}

function epidemicLevelRank_(level) {
  if (/第三級/.test(level)) return 3;
  if (/第二級/.test(level)) return 2;
  if (/第一級/.test(level)) return 1;
  return 0;
}

function epidemicDateForPlace_(text, target) {
  const terms = (target.terms || []).concat(target.region || []);
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!terms.some(function(term) { return lines[i].indexOf(term) >= 0; })) continue;
    const m = lines[i].match(/發布日期[:：]\s*(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return '';
}

function epidemicDiseaseName_(diseaseName) {
  const d = String(diseaseName || '');
  const map = {
    '伊波拉': '伊波拉病毒感染',
    '登革熱': '登革熱',
    '新型A型流感': '新型A型流感',
    '新冠': '新冠併發重症',
    '立百病毒': '立百病毒感染症',
    '馬堡病毒': '馬堡病毒出血熱',
    'M痘': 'M痘',
    '麻疹': '麻疹',
    '黃熱病': '黃熱病',
    '瘧疾': '瘧疾',
    '霍亂': '霍亂',
    '茲卡': '茲卡病毒感染症',
    '屈公病': '屈公病',
    '拉薩熱': '拉薩熱'
  };
  return map[d] || d;
}

function cleanEpidemicLines_(text) {
  const out = [];
  String(text || '').split('\n').forEach(function(raw) {
    let line = cleanKnowledgeLine_(raw);
    if (!line) return;
    line = normalizeTravelLevelText_(line.replace(/^\s*-\s*/, ''));
    if (/^疾病：/.test(line)) return;
    if (/^地區清單：?$/.test(line)) return;
    if (/目前疫區$|疫區摘要$/.test(line)) return;
    if (/^[^：\n]+[🔴🟠🟡]\s*第[一二三]級：(警告|警示|注意)$/.test(line)) return;
    out.push(line);
  });
  return out;
}

function dedupeLines_(lines) {
  const seen = {};
  return (lines || []).filter(function(line) {
    line = String(line || '').trim();
    if (!line || seen[line]) return false;
    seen[line] = true;
    return true;
  });
}

function diseaseInfectionControlProfile_(name) {
  const profiles = {
    '兔熱病': {
      category: '第四類法定傳染病（1 週內通報，ICD-10: A21）',
      placement: '採標準防護措施；若有皮膚病灶包覆妥當即可，肺兔熱病個案採飛沫隔離。',
      order: '登入 HIS 完成第四類法定傳染病通報（1 週內完成）。',
      ppe: '照護皮膚病灶或採血時穿戴手套、外科口罩與隔離衣。',
      specimen: '檢體種類：全血 (紫頭管 3-5 mL)、血清 (黃頭管 3-5 mL)；開立 HIS「`CDCN0045` / `CDCN0186` 兔熱病檢體送驗醫令」。',
      sanitization: '病室環境以 1,000 ppm 漂白水擦拭消毒。',
      care: '經野生動物（兔類、齧齒類）接觸或蜱蟲叮咬感染；治療首選 Gentamicin 或 Doxycycline。'
    },
    '黃熱病': {
      category: '第五類法定傳染病（24 小時內通報，ICD-10: A95）',
      placement: '採防蚊隔離；病室加裝防蚊紗窗與掛蚊帳，防範院內蚊媒傳播。',
      order: '開立 ANN00049 防蚊隔離；登入 HIS 完成第五類法定傳染病通報（24 小時內）。',
      ppe: '採標準防護措施；接觸血液體液穿戴手套與防護裝備。',
      specimen: '血清 3-5 mL；開立 HIS「`CDCN0096` 黃熱病送驗醫令」。',
      sanitization: '病室環境清除積水容器與病媒蚊孳生源。',
      care: '埃及斑蚊叮咬傳染；赴非洲/中南美疫區前 10 天需施打黃熱病疫苗並持黃皮書。'
    },
    'Q熱': {
      category: '第四類法定傳染病（1 週內通報，ICD-10: A78）',
      placement: '採標準防護措施，一般病室收治即可。',
      order: '登入 HIS 完成第四類法定傳染病通報（1 週內）。',
      ppe: '採標準防護；採血或接觸體液穿戴手套。',
      specimen: '全血 3-5 mL (紫頭管) ＋ 血清 3-5 mL；開立 HIS「`CDCN0004` / `CDCN0005` Q熱送驗醫令」。',
      sanitization: '病室環境依標準清消流程。',
      care: '吸入受家畜（牛羊）胎盤/排泄物塵土感染；首選治療為 Doxycycline。'
    },
    '疥瘡': {
      category: '疥瘡感染管制依院內核定措施辦理，非 CDC 法定傳染病通報項目。',
      placement: '採接觸隔離並優先單人安置；無單人房時僅與相同診斷者集中照護，避免與未感染或高風險病人同室。',
      order: '開立院內現行疥瘡接觸隔離醫囑；醫囑名稱與取消方式以院內系統最新版為準。',
      ppe: '接觸病人皮膚、衣物、床單或環境前穿戴手套與隔離衣，離房前脫除並立即執行手部衛生。',
      specimen: '通常依皮膚科臨床評估，必要時採皮屑或病灶檢體；檢體與醫令依院內檢驗流程辦理。',
      sanitization: '環境安排最後清掃；專用或拋棄式清潔用具，用後以 1:50（約 1,000 ppm）漂白水完全浸泡至少 10 分鐘。',
      care: '病人衣物與床單被服以 60°C 以上熱水清洗至少 10 分鐘並高熱乾燥；接觸者依院內疥瘡措施同步評估。'
    },
    'VRE': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；優先單人病室（含獨立衛浴），若無單人房可集中安置；避免與留置管路、開放性傷口病人同室。',
      order: '開立 ANN00025 接觸隔離-VRE；解隔開立 ANN10025 取消「VRE接觸隔離」。',
      ppe: '進入病室穿戴隔離衣與手套；離房前脫除並落實手部衛生。',
      specimen: '依感染部位採集臨床檢體（尿液/傷口/血液）或肛門拭子 (Rectal Swab)；開立 VRE 培養與藥敏醫令。',
      sanitization: '每日與出院終期環境表面使用 1,000 ppm 漂白水擦拭消毒。',
      care: '嚴格執行接觸防護、洗手五時機，聽診器與血壓計專用或用後清消。'
    },
    'CRE': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；優先單人病室或集中安置。',
      order: '開立 ANN00027 接觸隔離-CRE；解隔開立 ANN10027 取消「CRE接觸隔離」。',
      ppe: '進入病室穿戴隔離衣與手套；離房前脫除並落實手部衛生。',
      specimen: '臨床檢體或肛門拭子；開立 CRE 培養及藥敏醫令。',
      sanitization: '每日與出院終期環境表面使用 1,000 ppm 漂白水擦拭消毒。',
      care: '落實接觸防護、洗手五時機。'
    },
    'MRSE': {
      category: '院內常見抗藥性凝固酶陰性葡萄球菌，非 CDC 法定傳染病通報項目，不須送驗 CDC',
      placement: '單純檢出 MRSE 不等於一定需要接觸隔離；需先判斷是污染、移生或臨床感染。若有未包覆傷口、大量引流、無法控制分泌物，或感染管制中心判定有傳播風險，再依接觸防護或單位流程處理。',
      order: 'MRSE 不須送驗 CDC，通常也不是 VRE、CRE、CRAB、CRPA、MRSA 等院內重點 MDRO 隔離醫囑主體；不要只因報告出現 MRSE 就自行開立特殊隔離。若需標示或隔離，請依院內正式系統與感管中心判斷。',
      ppe: '照護時以標準防護為基礎；接觸血液、體液、傷口、引流液或污染環境時戴手套，可能噴濺時加口罩、護目或面罩。若採接觸防護，依接觸隔離穿戴隔離衣與手套。',
      specimen: 'MRSE 不須送驗 CDC。依感染部位送本院臨床檢體培養與藥敏；若疑似血液培養污染或導管相關感染，請由臨床醫師依採血套數、臨床症狀與培養結果判斷。',
      sanitization: '一般環境依標準清潔消毒；若有血液、體液、傷口滲液或隔離情境，依院內環境清消與接觸防護終期清潔流程。',
      care: 'MRSE 常見於皮膚菌叢或醫療照護相關感染判讀情境。回答同仁時要先釐清檢體來源、病人症狀、是否有導管或人工植入物，不要直接等同 MRSA 或 VRE 流程。'
    },
    'MRSA': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；單人病室或集中安置。',
      order: '開立 ANN00024 接觸隔離-MRSA；解隔開立 ANN10024 取消「MRSA接觸隔離」。',
      ppe: '進入病室穿戴隔離衣與手套。',
      specimen: '鼻腔拭子或傷口拭子；開立 MRSA 培養及藥敏醫令。',
      sanitization: '每日與出院終期環境表面使用 1,000 ppm 漂白水擦拭消毒。',
      care: '落實接觸防護、傷口敷料包紮。'
    },
    'CRAB': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；單人病室或集中安置。',
      order: '開立 ANN00051 接觸隔離-CRAB；解隔開立 ANN10051 取消醫囑。',
      ppe: '進入病室穿戴手套與隔離衣。',
      specimen: '痰液、尿液或傷口檢體；開立 CRAB 培養及藥敏醫令。',
      sanitization: '環境高頻接觸表面使用 1,000 ppm 漂白水擦拭消毒（維持 10 分鐘）。',
      care: '落實接觸防護與手部衛生。'
    },
    'CRPA': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；單人病室或集中安置。',
      order: '開立 ANN00058 接觸隔離-CRPA；解隔開立 ANN10058 取消醫囑。',
      ppe: '進入病室穿戴手套與隔離衣。',
      specimen: '痰液、尿液或傷口拭子；開立 CRPA 培養醫令。',
      sanitization: '每日與出院終期使用 1,000 ppm 漂白水擦拭消毒。',
      care: '注意潮濕環境與呼吸照護器材感管。'
    },
    'MDRO': {
      category: '院內感管監測抗藥菌（免報 CDC）',
      placement: '採接觸隔離；優先單人房或集中安置。',
      order: '開立對應 ANN 接觸隔離醫囑。',
      ppe: '進入病室穿戴手套與隔離衣。',
      specimen: '臨床檢體培養與藥敏試驗。',
      sanitization: '每日與出院終期環境表面使用 1,000 ppm 漂白水擦拭消毒。',
      care: '落實接觸防護與手部衛生。'
    },
    '麻疹': {
      category: '第二類法定傳染病（24 小時內通報，ICD-10: B05.9）',
      placement: '採空氣隔離；優先收治於負壓隔離病室，關閉房門。',
      order: '開立 ANN00046 空氣隔離-麻疹；解隔開立 ANN10046 取消醫囑；完成第二類法傳通報（24 小時內）。',
      ppe: '照護人員強制佩戴 N95 呼吸防護口罩、手套與隔離衣。',
      specimen: '檢體種類：咽喉拭子 (VTM管) 及血清 5 mL；開立 HIS「`CDCN0122` 麻疹檢體送驗醫令」。',
      sanitization: '退房後病室抽風換氣 2 小時後執行終末清消。',
      care: '嚴格執行空氣隔離與接觸者造冊，出疹後 4 天內維持隔離。'
    },
    '德國麻疹': {
      category: '第二類法定傳染病（24 小時內通報，ICD-10: B06）',
      placement: '採飛沫隔離並優先安置單人病室；避免與懷孕婦女及未具免疫力的幼兒接觸。疑似或確診個案隔離至出疹後 7 天。',
      order: '開立院內現行德國麻疹飛沫隔離醫囑，並完成第二類法定傳染病通報（24 小時內）；醫囑代碼請以院內系統最新版為準。',
      ppe: '近距離照護佩戴外科口罩；接觸呼吸道分泌物時加戴手套並落實手部衛生。',
      specimen: '喉頭拭液及血清；開立 CDCN0122 喉頭拭液與 CDCN0121 血清送驗醫囑。',
      sanitization: '依一般環境清潔消毒原則處理高頻接觸表面，並加強手部衛生。',
      care: '立即確認接觸者中是否有懷孕婦女或未具免疫力者；先天性德國麻疹症候群病嬰需另依長期排毒規範隔離。'
    },
    '百日咳': {
      category: '第三類法定傳染病（1 週內通報，ICD-10: A37.0 / A37.9）',
      placement: '採飛沫隔離；優先單人病室並關閉房門。',
      order: '開立 ANN00038 飛沫隔離-百日咳；解隔開立 ANN10038 取消醫囑；完成第三類法傳通報（1 週內）。',
      ppe: '近距離照護佩戴外科口罩或 N95 口罩、手套與隔離衣。',
      specimen: '檢體種類：鼻咽拭子 (NP Swab in Regan-Lowe/VTM管)；開立 HIS「`CDCN0038` 百日咳檢體送驗醫令」（接觸者採檢特別開立 `CDCN0146`）。',
      sanitization: '每日以 1,000 ppm 漂白水擦拭消毒；退房執行終末清消。',
      care: '密切接觸者給予口服 Azithromycin 預防性投藥。'
    },
    '登革熱': {
      category: '第二類法定傳染病（24 小時內通報，ICD-10: A90 / A91）',
      placement: '重點為防蚊隔離；病室加裝防蚊紗窗與掛蚊帳。',
      order: '開立 ANN00049 防蚊隔離；解隔開立 ANN10049 取消醫囑；完成第二類法傳通報（24 小時內）。',
      ppe: '採標準防護措施；接觸血液體液佩戴手套與口罩。',
      specimen: '血清 3-5 mL；開立 HIS「`CDCN0002` 登革熱檢驗送驗醫令」及 NS1 快篩醫令。',
      sanitization: '環境清除積水容器與病媒蚊孳生源。',
      care: '防蚊隔離，嚴禁使用 Aspirin/NSAIDs 止痛退燒。'
    },
    '流感': {
      category: '第四類法傳流感重症（1 週內通報，ICD-10: J10 / J11）',
      placement: '採飛沫隔離；優先單人病室或同類集中照護。',
      order: '開立 ANN00039 飛沫+接觸隔離-季節流感；解隔開立 ANN10039 取消醫囑。',
      ppe: '近距離照護佩戴外科口罩（氣霧處置佩戴 N95）。',
      specimen: '鼻咽拭子 (NP Swab in VTM管)；開立流感快篩/PCR醫令。',
      sanitization: '每日以 1,000 ppm 漂白水擦拭消毒。',
      care: '及早評估抗病毒藥物 (Tamiflu) 使用。'
    },
    '新冠': {
      category: '第四類法傳新冠重症（1 週內通報，ICD-10: U07.1）',
      placement: '採飛沫與接觸隔離；單人病室或集中安置。',
      order: '開立 ANN00061 飛沫+接觸隔離-COVID-19；解隔開立 ANN10061 取消醫囑。',
      ppe: '佩戴外科口罩或 N95、隔離衣、手套與防護面罩。',
      specimen: '鼻咽拭子 (NP Swab)；開立 COVID-19 PCR/快篩醫令。',
      sanitization: '每日以 1,000 ppm 漂白水擦拭消毒。',
      care: '落實自主健康管理與症狀監測。'
    },
    '水痘': {
      category: '水痘併發症屬第三類法定傳染病（1 週內通報，ICD-10: B01）',
      placement: '採空氣＋接觸隔離；優先安置負壓隔離病室並關閉房門。',
      order: '開立 ANN00042 空氣＋接觸隔離-水痘；解隔開立 ANN10042 取消醫囑。',
      ppe: '進入病室佩戴 N95、隔離衣與手套；由具有水痘免疫力的工作人員優先照護。',
      specimen: '依臨床需要採水泡液、痂皮或病灶拭子進行 VZV 檢驗；送驗方式依院內檢驗醫令辦理。',
      sanitization: '每日及退房後先清除可見髒污，再以 0.05%～0.06%（500～600 ppm）漂白水或設備相容的核准消毒劑處理高頻表面與共用設備；病人用品儘量專用。退房後先依負壓病室換氣規範完成空氣清除，再執行終期清潔。',
      care: '維持空氣＋接觸隔離至所有水泡乾燥結痂且沒有新病灶；免疫功能低下者需個別評估。'
    }
  };

  return profiles[name] || null;
}

function diseaseFullOverviewReply_(diseaseName, profile) {
  const hisCodePart = extractHisOrderCode_(profile.specimen, diseaseName);

  return '🛡️ **' + diseaseName + ' 感染管制與臨床處置標準 SOP 總覽**：\n\n' +
    '【📋 1. 法定通報與時限】\n   · ' + profile.category + '\n\n' +
    '【🏥 2. 床位安置與隔離醫囑】\n   · 安置原則：' + profile.placement + '\n   · 隔離醫囑：' + profile.order + '\n\n' +
    '【🛡️ 3. 防護裝備 (PPE)】\n   · ' + profile.ppe + '\n\n' +
    '【🧪 4. 採檢送驗與 HIS 醫令】\n   · 檢體種類：' + profile.specimen + '\n   · HIS 醫令：' + hisCodePart + '\n\n' +
    '【🧹 5. 環境清消與感控重點】\n   · 環境消毒：' + profile.sanitization + '\n   · 照護重點：' + profile.care + '\n' +
    nextSubtopicPrompt_(diseaseName);
}

function diseaseSubtopicReply_(diseaseName, profile, subtopic) {
  if (!profile) return null;

  if (subtopic === 'definition') {
    const definitionReply = cdcNotificationDefinitionReply_(diseaseName);
    if (definitionReply) return definitionReply;
    return diseaseName + '通報定義目前在本地知識庫沒有完整條件。\n\n' +
      '- 請先確認疾管署「病例定義暨防疫檢體採檢送驗事項」最新公告。\n' +
      '- 若符合或疑似符合法定傳染病通報條件，仍應依通報時限與院內流程辦理。\n' +
      '- 疾管署病例定義頁：https://www.cdc.gov.tw/Category/DiseaseDefine/ZW54U0FpVVhpVGR3UkViWm8rQkNwUT09';
  }

  if (subtopic === 'clearance') {
    const mdroClearance = mdroClearanceReply_(diseaseName);
    if (mdroClearance) return mdroClearance;
    return safeDiseaseSubtopicFallback_(diseaseName, 'clearance');
  }

  if (subtopic === 'exposure') {
    if (/^(麻疹|百日咳|HIV|針扎與體液暴露)$/.test(diseaseName)) {
      return postExposurePepReply_(diseaseName + ' 暴露處置');
    }
    return diseaseName + '目前未設定常規「暴露造冊/預防用藥」快捷流程。\n\n' +
      '- 若為法定傳染病疑似或確定個案，請先完成通報與院內感染管制通知。\n' +
      '- 是否匡列接觸者、造冊、追蹤或預防用藥，需依疾病別傳播途徑與感染管制中心指示判斷。\n' +
      '- 若只是一般照護暴露疑慮，請補充是同住、同病室、照護、檢查轉送或血液體液暴露。';
  }

  if (subtopic === 'placement') {
    return '🛌 **' + diseaseName + ' 病房安排與收治建議**：\n\n' +
      '【🏥 1. 床位與安置原則】\n   · ' + profile.placement + '\n\n' +
      '【🛑 2. 對應隔離醫囑】\n   · ' + profile.order + '\n\n' +
      '【🛡️ 3. 建議防護裝備 (PPE)】\n   · ' + profile.ppe + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  if (subtopic === 'order') {
    return '📝 **' + diseaseName + ' 通報與隔離醫囑處置**：\n\n' +
      '【📋 1. 法傳通報類別】\n   · ' + profile.category + '\n\n' +
      '【🛑 2. 院內隔離醫囑】\n   · ' + profile.order + '\n\n' +
      '【🛡️ 3. 建議防護裝備 (PPE)】\n   · ' + profile.ppe + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  if (subtopic === 'specimen') {
    const hisCodePart = extractHisOrderCode_(profile.specimen, diseaseName);
    const sendFlow = isMdroTerm_(diseaseName)
      ? 'MDRO/MRSE 等抗藥菌原則送本院檢醫部檢驗，不是送驗 CDC；若需院內篩檢，診療醫令 → 主分類「細菌」→ 次分類「感管篩選」，依菌種與採檢部位選擇醫令。'
      : '總院目前無須列印紙本送驗單；開立醫令碼後由院內採檢與檢醫部流程銜接，防疫檢體由感染管制中心依規定送疾病管制署。若 CDC 需附病情摘要或照片，請先完成電子病歷。';
    return '🧪 **' + diseaseName + ' 採檢醫令與送驗重點**：\n\n' +
      '【🧪 1. HIS 檢驗醫令碼】\n   · ' + hisCodePart + '\n\n' +
      '【🧫 2. 檢體種類與專用容器】\n   · ' + profile.specimen + '\n\n' +
      '【🛑 3. 對應隔離醫囑】\n   · ' + profile.order + '\n\n' +
      '【🚚 4. 總院送驗流程】\n   · ' + sendFlow + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  if (subtopic === 'isolation') {
    return '🛑 **' + diseaseName + ' 隔離醫囑與病房處置**：\n\n' +
      '【🛑 1. 院內隔離醫囑】\n   · ' + profile.order + '\n\n' +
      '【🏥 2. 床位與安置原則】\n   · ' + profile.placement + '\n\n' +
      '【🛡️ 3. 建議防護裝備 (PPE)】\n   · ' + profile.ppe + '\n\n' +
      '【🧹 4. 環境與高頻表面消毒】\n   · ' + profile.sanitization + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  if (subtopic === 'sanitization') {
    return '🧹 **' + diseaseName + ' 環境清消與終末消毒重點**：\n\n' +
      '【🧹 1. 環境消毒重點】\n   · ' + profile.sanitization + '\n\n' +
      '【🛑 2. 病房隔離醫囑】\n   · ' + profile.order + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  if (subtopic === 'care') {
    return '🩺 **' + diseaseName + ' 臨床照護與感控重點**：\n\n' +
      '【🩺 1. 臨床照護措施】\n   · ' + profile.care + '\n\n' +
      '【🛑 2. 院內隔離醫囑】\n   · ' + profile.order + '\n' +
      nextSubtopicPrompt_(diseaseName);
  }

  return null;
}

function genericDiseaseSanitizationReply_(diseaseName) {
  const d = String(diseaseName || '本疾病').trim();
  return d + '環境清消重點：\n' +
    '- 目前院內資料未見此疾病的專屬消毒濃度；不引用其他疾病或特殊單位的清消數字。\n' +
    '- 先清除可見髒污，再依一般或特殊感染症環境清潔流程，以院內核准且適合表面／設備材質的消毒劑處理高頻接觸面。\n' +
    '- 病人用品儘量專用，共用設備於每次使用後清消；轉床、出院或解隔後執行終期清潔。\n' +
    '- 若有血液、體液大量污染、特殊病原或疫情專案規定，依疾病別措施與感管中心最新指示提高濃度或調整流程。';
}

function safeDiseaseSubtopicFallback_(diseaseName, subtopic) {
  const d = String(diseaseName || '').trim();
  if (!d) return '';
  const replies = {
    definition: d + '通報定義：目前知識庫未載明可直接引用的完整疾病別病例條件，因此不以其他疾病或通用通報文字代替。\n- 請依疾管署最新病例定義確認臨床條件、檢驗條件與通報時限。\n- 疑似符合時，先依院內通報流程聯繫感染管制中心確認。',
    order: d + '隔離醫囑：目前知識庫未載明經確認的疾病別院內醫囑代碼，因此不套用其他疾病的 ANN 醫囑。\n- 先依傳播途徑採取必要防護。\n- 請由院內現行隔離醫囑清單或感染管制中心確認正式醫囑名稱與取消方式。',
    isolation: d + '隔離處置：目前知識庫未載明經確認的疾病別隔離醫囑，因此不套用呼吸道病毒或其他疾病模板。\n- 先維持標準防護並依已知傳播途徑加強防護。\n- 病室、PPE及醫囑請依院內現行疾病別規範確認。',
    placement: d + '病人安置：目前知識庫未載明經確認的疾病別床位條件，因此不引用「隔壁床」衛教或其他疾病安置方式。\n- 安置前確認傳播途徑、是否能控制分泌物或排泄物，以及是否有氣霧處置。\n- 單人房、負壓或集中照護需求請依院內現行疾病別規範確認。',
    specimen: d + '採檢送驗：目前知識庫未載明可確認的疾病別檢體、容器或醫令，因此不引用其他疾病的採檢內容。\n- 請依疾管署最新「病例定義暨防疫檢體採檢送驗事項」及院內檢驗醫令確認。\n- 防疫檢體送驗前請聯繫感染管制中心。',
    care: d + 'PPE與照護：目前知識庫未載明經確認的疾病別 PPE 組合，因此不套用其他疾病的防護裝備。\n- 以標準防護為基礎，再依接觸、飛沫、空氣或血液體液暴露風險加強。\n- 執行氣霧處置或可能噴濺作業前，請依院內現行規範完成風險評估。',
    clearance: d + '解除隔離：目前知識庫未載明經確認的疾病別解除條件，因此不提供推測的固定天數、陰性次數或取消醫囑。\n- 在確認正式條件前維持原防護措施，不自行解隔。\n- 請依院內現行疾病別規範及感染管制中心確認症狀、時間、檢驗與取消醫囑條件。'
  };
  return replies[subtopic] || '';
}

function auditDiseaseTopicReply_(diseaseName) {
  const d = String(diseaseName || '').trim();
  if (!d) return '';
  const profile = diseaseInfectionControlProfile_(d);
  const lines = [d + '評鑑查核重點：'];

  if (d === '麻疹') {
    lines.push('- 對應查核面向：法定傳染病通報時效、空氣隔離與病人安置、N95/PPE、接觸者造冊及員工暴露後健康監測。');
    lines.push('- 委員可能詢問：疑似麻疹如何辨識與通報、病人安置在哪裡、接觸者如何匡列、同仁暴露後如何追蹤。');
    lines.push('- KM 可查閱佐證：麻疹感染管制措施、法定傳染病通報流程、接觸者處置及相關表單。');
    lines.push('- 現場／系統執行紀錄：通報紀錄、隔離醫囑、接觸者名冊、員工健康監測及暴露追蹤紀錄。');
  } else if (d === '庫賈氏病') {
    lines.push('- 對應查核面向：CJD 風險辨識、手術或侵入性處置前勾稽、器械分流與去活化、跨單位通知及紀錄保存。');
    lines.push('- 委員可能詢問：如何確認列管狀態、臨時排程如何補查、涉及中高感染力組織時器械如何處理。');
    lines.push('- 現場回答重點：先查院內 CJD 勾稽歷程及排程列管狀態；必要處置前通知手術室、供應室與感染管制中心，器械依感染力分流並按正式規範處理。');
    lines.push('- KM 可查閱佐證：核定之「庫賈氏病感染管制措施」及相關作業表單。');
    lines.push('- 現場／系統執行紀錄：CJD 勾稽紀錄、手術或檢查排程紀錄、跨單位通知紀錄、器械分流及去活化處理紀錄。');
  } else {
    lines.push('- 對應查核面向：通報、隔離標示、PPE、病人安置、採檢送驗、環境清消及相關紀錄。');
    lines.push('- 委員可能詢問：第一線如何辨識、啟動流程、留下紀錄並確認措施已完成。');
    lines.push('- KM 可查閱佐證：現行核定感染管制措施、通報流程、相關表單及教育訓練資料。');
    lines.push('- 現場／系統執行紀錄：依該疾病實際流程產生的醫囑、通報、採檢、隔離、清消或追蹤紀錄。');
  }

  if (profile && d !== '庫賈氏病') lines.push('- 現場回答重點：' + profile.placement + '；' + profile.ppe);
  if (d === '庫賈氏病') {
    lines.push('- KM 位置：登入院內 KM 系統，查詢文件編號 50300-3-000013「庫賈氏病感染管制措施」。');
  } else {
    lines.push('- KM 位置：登入院內 KM 系統，搜尋單位「50300 感染管制中心」，查詢「' + d + '感染管制措施」或相關通報流程。');
  }
  return lines.join('\n');
}

function auditGeneralTopicReply_(question, event) {
  if (getUserMode_(event) !== 'audit') return '';
  const q = normalizeIntentText_(question);
  if (/^(傳染病通報|法定傳染病通報|通報機制|疾病通報)$/.test(q.replace(/\s+/g, ''))) {
    return officialAuditClauseReply_('查核條文 4.1 重點');
  }
  if (/^(感染率監測|感染率|HAI監測|醫療照護相關感染監測|院內感染監測)$/.test(q.replace(/\s+/g, ''))) {
    return officialAuditClauseReply_('查核條文 1.6 重點');
  }
  const menuReply = auditBroadTopicMenuReply_(q);
  if (menuReply) return menuReply;
  const officialReply = officialAuditClauseReply_(q);
  if (officialReply) return officialReply;
  // An explicit clause query must never fall through to generic KB retrieval.
  // If the separate audit file is unavailable, generic search may expose
  // obsolete shared-drive paths instead of the official KM evidence.
  const explicitClause = q.match(/(?:查核)?(?:條文)?\s*([1-5]\.[1-7])/i);
  if (explicitClause) {
    return {
      text: '查核條文 ' + explicitClause[1] + ' 的正式資料目前尚未同步完成，暫不提供未經確認的內容。請更新評鑑查核知識庫後再查詢；佐證資料僅提供 KM 系統文件。',
      clauseId: explicitClause[1],
      clauseTitle: '評鑑查核'
    };
  }
  const detectedDisease = detectDisease_(q);
  const topics = auditClauseTopics_();
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    if (!topic.pattern.test(q)) continue;
    if (detectedDisease && topic.title === '感染管制教育訓練') continue;
    return topic.title + '查核重點：\n' +
      '- 查核要求：' + topic.requirement + '\n' +
      '- 委員可能的提問：' + topic.questions + '\n' +
      '- 可出示紀錄：' + topic.evidence + '\n' +
      '- KM：' + topic.km;
  }
  return '';
}

function catheterCareReply_(question, event) {
  const q = normalizeIntentText_(question).replace(/\s+/g, '');
  if (!/^(導管照護|管路照護|侵入性導管照護)$/.test(q)) return null;
  if (getUserMode_(event) === 'audit') return null;
  return {
    text: '導管種類不同，照護與更換原則不能混用。請選擇：\n' +
      '- 中心靜脈導管照護\n' +
      '- 導尿管照護\n' +
      '- 呼吸器管路照護'
  };
}

function auditBroadTopicMenuReply_(question) {
  const q = normalizeIntentText_(question).replace(/\s+/g, '');
  if (/^(抗生素管制|抗生素管理|抗菌藥物管理|抗微生物製劑管理)$/.test(q)) {
    return {
      text: '抗生素管理涉及三項查核條文，請選擇要詳查的方向：\n' +
        '- 計畫與權責：管理小組、領導支持、跨專業分工及年度目標。\n' +
        '- 使用監測：抗生素用量、處方適當性、管制藥審核、去升階及手術預防性用藥。\n' +
        '- 抗藥性防治：抗藥性趨勢、檢驗警示、隔離措施、群聚調查及改善。',
      auditTopicMenu: 'antibiotic'
    };
  }
  if (/^(防疫|防疫政策|疫情政策|防疫查核|疫情應變政策)$/.test(q)) {
    return {
      text: '防疫政策涉及數項查核條文，請選擇要詳查的方向：\n' +
        '- 手冊與疫情資訊：政策更新、教育訓練及國際疫情傳達。\n' +
        '- 隔離與應變：檢傷分流、隔離動線、PPE及大規模感染事件應變。\n' +
        '- 傳染病通報：通報時效、專責人員及衛生機關聯繫。\n' +
        '- 防疫物資：PPE安全庫存、規格、效期、盤點及緊急調度。\n' +
        '- 員工保護：疫苗、健康監測、胸部X光及暴露後處置。',
      auditTopicMenu: 'epidemic-policy'
    };
  }
  return null;
}

function officialAuditClauseReply_(question) {
  const q = normalizeIntentText_(question);
  const explicitMatch = q.match(/(?:查核)?(?:條文)?\s*([1-5]\.[1-7])(?:\s*(?:重點|委員提問|佐證|km|符合|優良))?/i);
  const auditData = loadAuditClauses_();
  const clauses = auditData.clauses || [];
  if (!clauses.length) return null;

  let selected = explicitMatch ? clauses.filter(function(item) { return item.id === explicitMatch[1]; })[0] : null;
  if (!selected) {
    const compact = q.replace(/\s+/g, '').toLowerCase();
    let bestScore = 0;
    clauses.forEach(function(item) {
      const terms = (item.aliases || []).concat([item.title || '']);
      terms.forEach(function(term) {
        const normalized = String(term || '').replace(/\s+/g, '').toLowerCase();
        if (!normalized || compact.indexOf(normalized) < 0) return;
        const score = normalized.length * 10 + (compact === normalized ? 1000 : 0);
        if (score > bestScore) {
          bestScore = score;
          selected = item;
        }
      });
    });
  }
  if (!selected) return null;

  const asksEvidence = /(?:km|佐證|紀錄|資料位置)/i.test(q);
  const asksQuestions = /委員.*(?:問|提問)|可能提問/i.test(q);
  const specialText = officialAuditClauseSpecialReply_(selected, asksEvidence, asksQuestions);
  if (specialText) return { text: specialText, clauseId: selected.id, clauseTitle: selected.title };
  const allEvidence = (selected.evidence || []).slice().sort(function(a, b) {
    const aKm = /^https:\/\/km\.ntuh\.gov\.tw\//i.test(String(a.url || '')) ? 0 : 1;
    const bKm = /^https:\/\/km\.ntuh\.gov\.tw\//i.test(String(b.url || '')) ? 0 : 1;
    return aKm - bKm;
  });
  const kmEvidence = allEvidence.filter(function(item) {
    return /^https:\/\/km\.ntuh\.gov\.tw\//i.test(String(item.url || ''));
  });
  const evidence = kmEvidence.slice(0, asksEvidence ? 10 : 4);
  const evidenceLines = evidence.map(function(item) {
    const name = String(item.name || '').trim();
    const url = String(item.url || '').trim();
    return '- ' + name + (url ? '：' + url : '');
  });
  let text;
  if (asksEvidence) {
    text = selected.title + '（查核條文 ' + selected.id + '）KM佐證：\n' + evidenceLines.join('\n');
  } else if (asksQuestions) {
    text = selected.title + '（查核條文 ' + selected.id + '）委員可能的提問：\n' +
      '- ' + selected.questions + '\n' +
      '- 回答方向：' + selected.focus + '\n' +
      '- 建議先備妥的 KM 佐證：' + evidence.map(function(item) { return item.name; }).join('、') + '。';
  } else {
    text = selected.title + '（查核條文 ' + selected.id + '）重點：\n' +
      '- 條文重點：' + selected.focus + '\n' +
      '- 委員可能的提問：' + selected.questions + '\n' +
      '- KM 可出示佐證：' + evidence.map(function(item) { return item.name; }).join('、') + '。';
  }
  const availableEvidenceCount = kmEvidence.length;
  if (availableEvidenceCount > evidence.length) {
    text += '\n- 其餘佐證請依1150726最新版條文佐證清單查閱。';
  }
  return { text: text, clauseId: selected.id, clauseTitle: selected.title };
}

function officialAuditClauseSpecialReply_(clause, asksEvidence, asksQuestions) {
  if (!clause) return '';
  if (clause.id === '1.6') {
    const title16 = '感染率監測與改善（查核條文 1.6）';
    if (asksEvidence) {
      return title16 + ' KM佐證：\n' +
        '【監測資料】\n' +
        '- THAS醫療照護相關感染通報統計表：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=22728\n' +
        '- 醫療照護相關感染月報摘要：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=19270\n' +
        '- 醫療照護相關感染年報：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=9412\n' +
        '【會議檢討】\n' +
        '- 感染管制委員會115年第2次HAI檢討紀錄：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=171103\n' +
        '- 品質暨病人安全委員會HAI檢討紀錄：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=15165&pi=5\n' +
        '【改善與成效】\n' +
        '- CLABSI改善計畫及成果：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=171126\n' +
        '- CAUTI改善計畫及報告：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=144976\n' +
        '- HAI異常事件調查報告：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=20190&pi=2';
    }
    if (asksQuestions) {
      return title16 + ' 委員可能的提問與回答方向：\n' +
        '- 問：監測哪些感染？\n  答：依單位風險監測HAI、侵入性裝置相關感染、重要菌株及群聚事件，並呈現分母、感染率與趨勢。\n' +
        '- 問：數據多久檢討、回饋給誰？\n  答：定期彙整月報或年報，回饋臨床單位並提送感染管制委員會或相關會議檢討。\n' +
        '- 問：怎麼知道是異常？\n  答：與單位歷史趨勢、院內警示值或適用基準比較；上升或群聚時啟動個案複核與現場調查。\n' +
        '- 問：改善是否有效？\n  答：提出原因、措施、負責人與完成期限，再以改善前後感染率、bundle執行率或再稽核結果驗證。\n' +
        '- 建議先備妥的 KM 佐證：THAS統計、月年報、會議檢討紀錄、異常調查及CLABSI／CAUTI改善成果。';
    }
    return title16 + ' 查核重點：\n' +
      '- 監測：依單位風險追蹤HAI、侵入性裝置相關感染、重要菌株及群聚事件，數據須有分母、感染率與趨勢。\n' +
      '- 回饋：定期將月報或年報回饋臨床單位，並提送感染管制委員會或相關會議檢討。\n' +
      '- 異常處理：感染率上升或出現群聚時，須複核個案、調查原因並提出改善計畫。\n' +
      '- 成效驗證：以改善前後感染率、bundle執行率或再稽核結果確認措施有效。\n' +
      '- 委員常問：目前主要風險與趨勢是什麼？異常如何啟動？改善後如何證明有效？\n' +
      '- KM 可出示佐證：THAS統計、HAI月年報、會議檢討紀錄、異常調查報告及CLABSI／CAUTI改善成果。';
  }
  if (clause.id === '4.1') {
    const title41 = clause.title + '（查核條文 4.1）';
    if (asksEvidence) {
      return title41 + ' KM佐證：\n' +
        '- 傳染病監視通報機制：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=87870\n' +
        '- 傳染病通報統計報表：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=157825\n' +
        '- 定期檢討通報機制紀錄：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=91204\n' +
        '- 院內傳染病檢體包裝及運送流程：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=87871\n' +
        '- 檢驗室檢體採集、傳送及接收規範：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=171109';
    }
    if (asksQuestions) {
      return title41 + ' 委員可能的提問與回答方向：\n' +
        '- 問：疑似法定傳染病如何啟動？\n  答：依疾病定義辨識後，於規定時限完成通報、必要採檢及隔離，並由專責人員複核。\n' +
        '- 問：夜間或假日由誰處理？\n  答：須有值班通報與代理機制，不能等到上班日才處理。\n' +
        '- 問：如何避免逾時或漏報？\n  答：以通報統計或系統紀錄追蹤時效、退補件與完成情形，定期檢討異常。\n' +
        '- 問：衛生機關要求補件怎麼辦？\n  答：由專責人員追蹤補件、檢體及後續防疫處置至完成。\n' +
        '- 建議先備妥的 KM 佐證：傳染病監視通報機制、通報統計報表、定期檢討紀錄、檢體包裝運送流程。';
    }
    return '傳染病通報（查核條文 4.1）查核重點：\n' +
      '- 委員要確認：疑似個案能依疾病別時限完成通報、採檢及隔離；夜間、假日也不中斷。\n' +
      '- 現場回答：由專責或代理人員通報並複核，持續追蹤退補件、檢體及衛生機關後續要求至完成。\n' +
      '- 委員常問：誰負責？夜間假日怎麼辦？如何證明沒有逾時、漏報或未完成補件？\n' +
      '- KM 可出示佐證：傳染病監視通報機制、通報統計報表、定期檢討紀錄、院內檢體包裝及運送流程。';
  }
  if (clause.id !== '5.1') return '';
  const title = clause.title + '（查核條文 5.1）';
  if (asksEvidence) {
    return title + ' KM佐證：\n' +
      '【預防接種】\n' +
      '- 員工預防接種措施：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=54430\n' +
      '- 醫療照護人員預防接種紀錄與資料庫：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=20370\n' +
      '- 流感及 COVID-19 疫苗接種成果：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=29190\n' +
      '【健康監測】\n' +
      '- 健康監測通報規範：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=117071\n' +
      '- 健康監測通報系統：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=91353\n' +
      '- 體溫異常追蹤及處理紀錄：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=20151\n' +
      '【胸部 X 光與暴露處置】\n' +
      '- 員工胸部 X 光檢查計畫、流程及異常追蹤：https://km.ntuh.gov.tw/km/readdocument.aspx?documentId=67831\n' +
      '- 員工暴露傳染性疾病調查與處理紀錄：https://km.ntuh.gov.tw/km/listfolders.aspx?uid=19220';
  }
  if (asksQuestions) {
    return title + ' 委員可能的提問與回答方向：\n' +
      '- 問：哪些人納入員工保護？\n  答：依工作與暴露風險涵蓋醫事、非醫事、適用之外包、實習及志工，並有名冊及完成情形。\n' +
      '- 問：疫苗如何管理？\n  答：依職別與風險訂定流感、MMR、B肝、水痘、Tdap及 COVID-19 等接種或免疫力評估；未完成、抗體陰性或禁忌者須追蹤。\n' +
      '- 問：員工出現症狀如何處理？\n  答：由健康監測系統通報，完成風險評估、工作限制、採檢或就醫安排及異常追蹤。\n' +
      '- 問：胸部 X 光如何落實？\n  答：依計畫追蹤應檢、已檢、異常結果、後續處理及達成率。\n' +
      '- 問：發生傳染病暴露怎麼辦？\n  答：完成接觸者調查、暴露風險分級、必要採檢或預防措施及追蹤結案。\n' +
      '- 建議先備妥的 KM 佐證：員工預防接種措施、接種紀錄與成果、健康監測通報規範與系統、胸部 X 光計畫及異常追蹤、員工暴露調查紀錄。';
  }
  return title + ' 重點：\n' +
    '- 條文重點：醫院須建立工作人員預防接種、健康監測、胸部 X 光及傳染病暴露後處置制度，並能提出執行率與異常追蹤結果。\n' +
    '- 預防接種：依職別與暴露風險管理流感、MMR、B肝、水痘、Tdap及 COVID-19 等接種或免疫力紀錄；追蹤未完成、抗體陰性與接種禁忌者。\n' +
    '- 健康監測：員工有發燒或傳染病相關症狀時，須完成通報、風險評估、工作限制及後續追蹤。\n' +
    '- 胸部 X 光：須有應檢名冊、完成率、異常結果通知、複檢或轉介紀錄。\n' +
    '- 暴露處置：遭遇傳染性疾病暴露時，須完成接觸者調查、採檢或預防措施及追蹤結案。\n' +
    '- 委員可能的提問：各類疫苗對象與完成率為何？未接種或抗體陰性如何追蹤？健康異常、胸部 X 光異常及暴露事件如何處理？\n' +
    '- KM 可出示佐證：員工預防接種措施、接種紀錄與成果、健康監測通報規範與系統、胸部 X 光檢查計畫及異常追蹤、員工暴露調查紀錄。';
}

function auditClauseTopics_() {
  return [
    {
      pattern: /疫苗|預防接種|抗體/, title: '員工疫苗與預防接種',
      requirement: '依工作人員職別、暴露風險及政府建議訂定疫苗與抗體評估政策，涵蓋專任人員、實習學生及適用的外包人員；禁忌、未接種及後續追蹤均須有紀錄。',
      questions: '哪些職別或高風險單位需要哪些疫苗或抗體檢測？新進人員如何評估？未接種、抗體陰性或有接種禁忌時如何追蹤？',
      evidence: '員工疫苗政策、風險評估、接種與抗體名冊、接種統計、未完成追蹤、禁忌或不接種文件、實習生通知及外包契約相關條款。',
      km: '50300-2-000013「員工保健感染管制規範」；50300-2-100007「員工預防接種措施」；8.4「水痘抗體監測及接種實施流程」。'
    },
    {
      pattern: /教育|訓練/, title: '感染管制教育訓練',
      requirement: '依新進、在職及不同職別安排必要課程。新進人員職前 1 小時並於到院半年內完成 5 小時；在職人員每年至少 3 小時；指定醫事職類須包含抗生素使用 1 小時。',
      questions: '各類人員應完成多少時數？未完訓如何催訓及追蹤？高風險作業是否另有實作訓練與能力查核？',
      evidence: '年度教育計畫、教材、簽到或 TMS 完訓紀錄、各職別完訓率、補訓追蹤、測驗或技術查核及缺失改善紀錄。',
      km: '50300-2-000009「感染管制教育訓練辦法」；50300-2-100060「感染管制教育及宣導施行細則」。'
    },
    {
      pattern: /手部衛生|洗手|乾洗手/, title: '手部衛生',
      requirement: '設備、用品、五時機執行、稽核回饋與改善均須落實；手套不可取代手部衛生。',
      questions: '何時乾洗手、何時濕洗手？單位遵從率如何？缺失如何回饋與改善？',
      evidence: '手部衛生稽核表、遵從率與正確率、回饋及改善追蹤、教育紀錄、乾洗手液與洗手設備巡查紀錄。',
      km: '50300-2-000008「手部衛生要點」；50300-2-100027「醫療人員手部衛生實施細則」。'
    },
    {
      pattern: /PPE|防護裝備|隔離標示|隔離病室|負壓/, title: '個人防護裝備與隔離',
      requirement: '依傳播途徑配置病室、標示及 PPE，確保人員會正確穿脫，並維持隔離病室與負壓設備管理。',
      questions: '不同隔離類型使用哪些 PPE？穿脫順序為何？負壓異常或床位不足時如何處理？',
      evidence: '隔離醫囑與標示、PPE配置與效期、穿脫技術查核、負壓監測、異常維修、隔離病室巡查及教育紀錄。',
      km: '50300-2-000005「感染管制隔離防護規範」；50300-2-000004「隔離病室管理辦法」及相關施行細則。'
    },
    {
      pattern: /導尿|中心導管|呼吸器|侵入性裝置|bundle/i, title: '侵入性裝置感染預防',
      requirement: '落實適應症、置放與維護 bundle、每日必要性評估、感染監測及適時移除。',
      questions: '為何仍需留置？每日如何評估？bundle缺失及感染事件如何改善？',
      evidence: '置放適應症、bundle照護表、每日必要性與移除紀錄、感染率、稽核結果及改善追蹤。',
      km: '感染管制中心相關導尿管、中心導管及呼吸器組合式照護規範與技術稽核表。'
    },
    {
      pattern: /抗生素|抗菌藥|抗微生物|ASP/i, title: '抗微生物製劑管理',
      requirement: '建立抗菌藥物管理機制，追蹤適應症、培養、管制藥申請、去升階或停藥，以及手術預防性抗生素。',
      questions: '管制性抗生素如何審核？如何依培養結果調整？超過建議期間如何說明？',
      evidence: '抗生素管理計畫、申請與審核紀錄、用量及抗藥性趨勢、處方稽核回饋、手術預防性抗生素指標。',
      km: '50300-6-000002「抗微生物製劑管理計畫」及相關用藥管理規範。'
    },
    {
      pattern: /(?:MDRO|抗藥菌|多重抗藥).*(?:管理|查核)|(?:管理|查核).*(?:MDRO|抗藥菌|多重抗藥)/i, title: '多重抗藥性菌株管理',
      requirement: '檢驗提示、接觸隔離、床位安排、器材清消、轉送通知、終期清潔及再入院追蹤須形成完整流程。',
      questions: '陽性後如何通知與隔離？再入院如何辨識？何時可解隔？',
      evidence: '微生物報告、隔離醫囑、系統警示、轉送通知、清消紀錄、篩檢與解隔紀錄、群聚調查及改善資料。',
      km: '50300-2-100034「抗藥菌感染管制措施」及各菌株篩檢、解隔相關規範。'
    },
    {
      pattern: /環境清潔|環境消毒|終期清潔|清消/, title: '環境清潔與消毒',
      requirement: '依區域、疾病與污染風險訂定清潔頻率、消毒劑濃度及接觸時間，並管理共用器材與終期清潔。',
      questions: '高頻表面有哪些？消毒劑如何泡製與標示？隔離病人轉出後如何驗證完成？',
      evidence: '清潔排程與紀錄、消毒劑泡製及濃度標示、終期清潔查核、共用器材清消、缺失改善及教育紀錄。',
      km: '50300-2-100005「環境清潔作業規定」；50300-2-100028「消毒劑使用規範」。'
    },
    {
      pattern: /器械|醫材|供應室|消毒滅菌|高層次消毒/, title: '醫材清洗消毒與滅菌',
      requirement: '依醫材用途及風險完成清洗、消毒或滅菌，維持分流、包裝、監測、儲存、運送與可追溯性。',
      questions: '如何選擇消毒或滅菌？如何確認滅菌成效？異常批次如何召回？',
      evidence: '清洗消毒流程、化學及生物監測、設備保養、滅菌批次、效期與儲存巡查、異常召回及改善紀錄。',
      km: '50300-2-000011「清潔與消毒滅菌管理要點」及供應室相關作業規範。'
    },
    {
      pattern: /針扎|尖銳物|血液體液暴露|注射安全/, title: '注射、尖銳物與職業暴露',
      requirement: '落實安全針具、尖銳物容器及標準防護，並建立暴露後立即處理、通報、評估、預防用藥與追蹤流程。',
      questions: '針扎後第一步做什麼？去哪裡通報與評估？追蹤是否完成？',
      evidence: '安全針具教育與稽核、尖銳物巡查、暴露通報單、檢驗與用藥、追蹤完成率、事件分析及改善紀錄。',
      km: '50300-3-000009「尖銳物傷害與血體液暴露之預防及暴露後處理措施」。'
    },
    {
      pattern: /員工健康|健康監測|員工症狀|群聚/, title: '員工健康與健康監測',
      requirement: '涵蓋各類工作人員，依症狀與群聚門檻完成通報、就醫、工作限制、追蹤及疫情期間頻率調整。',
      questions: '哪些症狀需通報？兩人以上類似症狀如何處理？不適合照護病人時如何安排？',
      evidence: '健康監測通報、單位窗口與代理人名冊、就醫及工作限制、群聚通知、調查追蹤與改善紀錄。',
      km: '50300-2-000013「員工保健感染管制規範」；50300-2-000015「健康監測通報規範」。'
    },
    {
      pattern: /法定傳染病|疫情通報|TOCC|通報流程/i, title: '法定傳染病與疫情通報',
      requirement: '能及早辨識疑似病例，依時限完成通報、採檢、隔離、動線與接觸者處置；不應等確診才啟動。',
      questions: '疑似個案如何啟動？誰負責通報及確認完成？逾時或群聚如何處理？',
      evidence: 'TOCC紀錄、法傳通報資料、採檢醫令、隔離與轉送紀錄、接觸者名冊、群聚調查及改善追蹤。',
      km: '法定傳染病通報作業流程、疾病別感染管制措施及群突發異常事件處理規範。'
    },
    {
      pattern: /HAI|感染監測|感染率|THAS/i, title: '醫療照護相關感染監測',
      requirement: '持續監測 HAI、裝置使用及抗藥菌趨勢，定期回饋臨床單位並對異常執行改善與成效追蹤。',
      questions: '單位目前主要感染風險為何？數據如何回饋？改善後如何確認有效？',
      evidence: '感染率與裝置使用資料、THAS通報、單位回饋、會議紀錄、異常調查、改善計畫及成效追蹤。',
      km: '感染管制中心 HAI 監測計畫、定義、通報及單位回饋相關規範。'
    },
    {
      pattern: /病人安置|床位|動線|轉送|外出檢查/, title: '病人安置與動線',
      requirement: '依傳播風險完成分流、床位、候診及檢查轉送安排，轉送前通知接收單位並完成相應防護與清消。',
      questions: '床位不足如何風險分層？外出檢查如何通知？轉送後設備與動線如何清消？',
      evidence: '床位與隔離醫囑、轉送通知、病人防護、接收單位交班、設備與動線清消及異常處理紀錄。',
      km: '感染管制隔離防護規範、隔離病室管理辦法及疾病別轉送檢查流程。'
    },
    {
      pattern: /廢棄物|污衣|布服|垃圾/, title: '感染性廢棄物與布服',
      requirement: '依感染風險分類、包裝、加蓋及運送，避免滲漏、飛散、刺傷與污染公共動線。',
      questions: '污染布服與感染性廢棄物如何分流？尖銳物及外袋破損如何處理？',
      evidence: '分類與運送流程、容器及標示巡查、布服處理、外包教育、異常事件及改善紀錄。',
      km: '50300-2-1000026「醫療布服處理感染管制措施」及感染性廢棄物相關院內規範。'
    },
    {
      pattern: /文件|現場回答|SOP|佐證|缺失改善/, title: '文件、佐證與現場作答',
      requirement: '正式 SOP、現場執行、紀錄、稽核、缺失改善及追蹤結果應可相互勾稽。',
      questions: '平常怎麼做？SOP在哪裡？異常通知誰？缺失如何改善並確認完成？',
      evidence: '最新版 SOP、現場紀錄、稽核表、缺失通知、原因分析、改善措施及複查結果。',
      km: '依查核主題至 KM「50300 感染管制中心」查詢現行核定規範與相關表單。'
    }
  ];
}

function cdcNotificationDefinitionReply_(diseaseName) {
  const d = String(diseaseName || '').trim();
  if (!d || isMdroTerm_(d)) return '';
  try {
    const exact = findNotifiableDiseaseEntry_(d);
    if (!exact) return '';

    const lines = cleanKnowledgeLinesForDefinition_(exact.text);
    const linkLine = lines.filter(function(line) { return /https?:\/\//.test(line); })[0] || '';
    const body = [];
    body.push(d + '通報定義查詢重點：');
    lines.forEach(function(line) {
      if (/^CDC 通報定義連結/.test(line)) {
        body.push('- CDC 病例定義連結：' + line.replace(/^CDC 通報定義連結[:：]\s*/, ''));
      } else {
        body.push('- ' + line);
      }
    });
    if (!linkLine) {
      body.push('- 疾管署病例定義頁：https://www.cdc.gov.tw/Category/DiseaseDefine/ZW54U0FpVVhpVGR3UkViWm8rQkNwUT09');
    }
    return body.join('\n');
  } catch (err) {
    console.error('cdcNotificationDefinitionReply_ skipped: ' + err.toString());
    return '';
  }
}

function findNotifiableDiseaseEntry_(diseaseName) {
  const d = normalizeNotifiableDiseaseName_(diseaseName);
  if (!d) return null;
  const kb = loadKb_();
  const entries = kb.entries || [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] || {};
    if (String(entry.source || '') !== '法定傳染病_依疾病通報檢索.md') continue;
    if (String(entry.title || '').trim() === d) return entry;
  }
  for (let j = 0; j < entries.length; j++) {
    const entry2 = entries[j] || {};
    if (String(entry2.source || '') !== '法定傳染病_依疾病通報檢索.md') continue;
    const text = String(entry2.text || '');
    if (text.indexOf('### ' + d) >= 0) return entry2;
  }
  return null;
}

function normalizeNotifiableDiseaseName_(name) {
  const d = String(name || '').trim();
  const map = {
    '急性C型肝炎': '急性病毒性C型肝炎',
    'C型肝炎': '急性病毒性C型肝炎',
    'C肝': '急性病毒性C型肝炎',
    '未定型肝炎': '急性病毒性肝炎未定型',
    '肝炎未定型': '急性病毒性肝炎未定型',
    '日腦': '日本腦炎',
    '流腦': '流行性腦脊髓膜炎',
    '水痘': '水痘併發症'
  };
  return map[d] || d;
}

function cdcSpecimenReply_(diseaseName) {
  const d = String(diseaseName || '').trim();
  if (!d) return '';
  if (isMdroTerm_(d)) {
    return d + '採檢送驗重點：\n' +
      '- MDRO/MRSE 等抗藥菌原則送本院檢醫部，不是送驗 CDC。\n' +
      '- 若要開立院內篩檢，路徑為：診療醫令 → 主分類「細菌」→ 次分類「感管篩選」，再依菌種與採檢部位選擇醫令。\n' +
      '- 採檢部位請依臨床感染/移生部位、院內抗藥菌篩檢流程與感染管制中心指示。';
  }

  try {
    const exact = findNotifiableDiseaseEntry_(d);
    if (!exact) return '';
    const lines = cleanKnowledgeLinesForDefinition_(exact.text);
    const specimenLine = lines.filter(function(line) { return /^院內檢驗醫令\/檢體：/.test(line); })[0] || '';
    const linkLine = lines.filter(function(line) { return /^CDC 通報定義連結：/.test(line); })[0] || '';
    const extraLines = [];
    String(exact.text || '').split(/\r?\n/).forEach(function(raw) {
      const line = cleanKnowledgeLine_(raw);
      if (/^送驗補充[:：]/.test(line)) extraLines.push(line.replace(/^送驗補充[:：]\s*/, ''));
    });

    const title = String(exact.title || normalizeNotifiableDiseaseName_(d)).trim();
    const body = [title + '採檢送驗重點：'];
    if (specimenLine) {
      body.push('- ' + specimenLine);
    } else {
      body.push('- 本地索引未列出明確院內醫令，請依疾管署病例定義下方「檢體種類」對應院內 CDC 其他檢體醫令。');
    }
    extraLines.slice(0, 2).forEach(function(line) { body.push('- 送驗補充：' + line); });
    if (linkLine) {
      body.push('- CDC 病例定義連結：' + linkLine.replace(/^CDC 通報定義連結[:：]\s*/, ''));
    }
    body.push('- 總院目前無須列印紙本送驗單；開立醫令碼後由院內採檢與檢醫部流程銜接，防疫檢體由感染管制中心依規定送疾病管制署。');
    body.push('- 若 CDC 需附病情摘要或照片，請先完成電子病歷，感染管制中心依法由電子病歷資料上傳。');
    return body.join('\n');
  } catch (err) {
    console.error('cdcSpecimenReply_ skipped: ' + err.toString());
    return '';
  }
}

function cleanKnowledgeLinesForDefinition_(text) {
  const out = [];
  const seen = {};
  String(text || '').split(/\r?\n/).forEach(function(raw) {
    let line = cleanKnowledgeLine_(raw);
    if (!line) return;
    line = line.replace(/^分類[:：]/, '分類：')
      .replace(/^通報時限[:：]/, '通報時限：')
      .replace(/^院內檢驗醫令\/檢體[:：]/, '院內檢驗醫令/檢體：')
      .replace(/^ICD 參考[:：]/, 'ICD 參考：');
    if (!/^(分類：|通報時限：|CDC 通報定義連結：|院內檢驗醫令\/檢體：|ICD 參考：)/.test(line)) return;
    if (seen[line]) return;
    seen[line] = true;
    out.push(line);
  });
  return out;
}

function mdroClearanceReply_(diseaseName) {
  const d = String(diseaseName || '').trim();
  if (!isMdroTerm_(d)) return '';
  const stopDrug = '採檢前需先停用對該抗藥菌有效、或可能影響培養結果的抗生素/抗黴菌藥物；停藥天數與藥物範圍依院內抗藥菌解隔流程與醫療團隊判斷。';
  const common = [
    d + '解除接觸隔離重點：',
    '- 先確認原感染病灶已改善，沒有持續發燒或感染症狀，原感染/移生部位也已處理完成。',
    '- 若有導管、引流管、傷口或造口，原則上需移除或確認原部位培養陰性，才進入解隔評估。',
    '- ' + stopDrug,
    '- 符合解隔條件後，需開立對應「取消隔離」醫囑來取消特殊註記，不是終止原本那張隔離醫囑。'
  ];
  if (d === 'VRE') {
    const rule = officialClearanceRule_('VRE');
    return rule && rule.reply ? rule.reply : '';
  } else if (/^(CRE|CRAB|CRPA|MRSA|MDROE|MDRO|耳念珠菌|Candida auris)$/i.test(d)) {
    common.splice(3, 0, '- 依菌種與院內規範採指定部位篩檢，並達到規定陰性次數後，才可評估解除接觸隔離。');
  } else if (d === 'MRSE') {
    return 'MRSE 通常不是院內重點 MDRO 解隔流程主體。\n\n' +
      '- 請先判斷是污染、移生或真正感染，並確認是否曾依感染管制中心建議開立隔離或特殊註記。\n' +
      '- 若沒有正式隔離醫囑或特殊註記，通常不是用 VRE/CRE 那套解隔篩檢流程。\n' +
      '- 若確曾因特殊情境採接觸防護，解除方式請依原開立原因、臨床狀況與感管中心判斷。';
  }
  return common.join('\n');
}

function generalClearanceReply_(diseaseName) {
  const d = String(diseaseName || '').trim();
  if (!d || isMdroTerm_(d)) return '';
  const normalized = normalizeNotifiableDiseaseName_(d);
  if (/水痘|水痘併發症|帶狀疱疹/.test(normalized)) {
    return d + '解除隔離重點：\n' +
      '- 水痘採空氣＋接觸隔離，維持至所有水泡病灶乾燥結痂、沒有新病灶，且臨床狀況穩定。\n' +
      '- 一般不要求常規檢驗陰性；解隔以病灶狀態為主。\n' +
      '- 若病人免疫功能低下、病灶持續出現或仍有未結痂水泡，先維持隔離並由醫療團隊／感管中心評估。\n' +
      '- 符合條件後開立 ANN10042 取消水痘隔離註記；不是終止原本的 ANN00042。';
  }
  if (/^(流感|季節性流感)$/.test(normalized) || /^(流感|季節性流感)$/.test(d)) {
    return influenzaClearanceReply_();
  }
  if (/德國麻疹/.test(normalized) || /德國麻疹/.test(d)) {
    return '德國麻疹解除隔離重點：\n' +
      '- 一般疑似或確診德國麻疹個案：維持飛沫隔離至出疹後 7 天；期滿且臨床狀況穩定後，才可評估解除隔離。\n' +
      '- 一般後天感染不要求常規檢驗陰性才解隔；如出疹日不明、診斷仍有疑義或涉及群聚，先洽醫療團隊／感管中心確認。\n' +
      '- 先天性德國麻疹症候群病嬰可能長期排毒，不能套用出疹後 7 天；原則上隔離至 1 歲，除非出生滿 3 個月後咽喉及尿液病毒檢驗符合解除條件。\n' +
      '- 符合條件後開立院內現行「取消德國麻疹隔離」醫囑；代碼請以院內系統最新版為準。';
  }
  const officialRule = officialClearanceRule_(d) || officialClearanceRule_(normalized);
  if (officialRule) {
    return d + '解除隔離重點：\n' +
      '- 防護類型：' + officialRule.precautions + '。\n' +
      '- 解除判定：' + officialRule.criteria + '\n' +
      '- 資料依據：' + (officialRule.source_title || '疾管署「依感染原及感染情形建議之防護措施及執行期間」及疾病別最新指引') + '。';
  }
  return safeDiseaseSubtopicFallback_(d, 'clearance');
}

function officialClearanceRule_(diseaseName) {
  const name = String(diseaseName || '').trim();
  if (!name) return null;
  const data = loadClearanceRules_();
  const rule = data.rules && data.rules[name];
  if (!rule) return null;
  return {
    precautions: String(rule.precautions || '依疾病別規範'),
    criteria: String(rule.criteria || ''),
    reply: String(rule.reply || ''),
    source: String(rule.source || data.primary_source || ''),
    source_title: String(rule.source_title || data.primary_source_title || '')
  };
}

function extractHisOrderCode_(specimenText, diseaseName) {
  const text = String(specimenText || '');
  const dis = String(diseaseName || '');
  if (isMdroTerm_(dis)) {
    return '非 CDC 防疫檢體。請開立本院細菌培養/藥敏或感管篩選醫令；路徑：診療醫令 → 主分類「細菌」→ 次分類「感管篩選」，依菌種與採檢部位選擇。';
  }

  const matches = text.match(/CDCN\d+|CDFI/gi);
  const otherOrderHint = cdcOtherSpecimenOrderHint_(text, dis);
  let baseCodeText = '';

  if (matches && matches.length > 0) {
    const uniqueCodes = Array.from(new Set(matches.map(function(c) { return c.toUpperCase(); })));
    baseCodeText = '**`' + uniqueCodes.join(' / ') + '`**（HIS 系統 ➔ 診療醫令 ➔ 主分類「檢驗」 ➔ 次分類「CDC防疫檢體」）';
  } else {
    baseCodeText = '**院內專用檢驗醫令 / CDC防疫檢體醫令**（HIS 系統 ➔ 診斷/採檢 ➔ 主分類「檢驗」 ➔ 次分類「CDC防疫檢體」）';
  }

  if (otherOrderHint) {
    baseCodeText += '\n   · 若院內法傳檢驗醫令 PDF 未列專屬 CDCN，可依 CDC 通報定義下方「檢體種類」選用：' + otherOrderHint;
  }

  if (/百日咳/i.test(dis) || /百日咳/i.test(text) || /CDCN0146/i.test(text)) {
    return baseCodeText + '\n   · ⚠️ **【關鍵強調】百日咳接觸者採檢醫令 `CDCN0146`**：若採檢對象為「百日咳匡列接觸者 / 暴露同仁」，請務必特別改開立 **`CDCN0146`（接觸者採檢醫令）**，切勿與指標個案 (Index Case) 通報醫令混淆！';
  }

  return baseCodeText;
}

function isMdroTerm_(diseaseName) {
  return /^(MDRO|VRE|CRE|MRSA|MRSE|CRAB|CRPA|MDROE|耳念珠菌|Candida auris)$/i.test(String(diseaseName || '').trim());
}

function cdcOtherSpecimenOrderHint_(specimenText, diseaseName) {
  if (isMdroTerm_(diseaseName)) return '';
  const text = String(specimenText || '').replace(/\s+/g, '');
  if (!text) return '';
  const orderMap = [
    { code: 'CDCN0153', name: 'CDC其他--糞便拭子 總院', re: /糞便拭子|肛門拭子|直腸拭子|肛拭子/ },
    { code: 'CDCN0159', name: 'CDC其他--肝膿瘍 總院', re: /肝膿瘍/ },
    { code: 'CDCN0154', name: 'CDC其他--咽喉拭子 總院', re: /咽喉拭子|咽喉擦拭|喉拭子|咽拭子|鼻咽拭子|鼻咽擦拭|鼻咽擦拭液|鼻腔拭子/ },
    { code: 'CDCN0160', name: 'CDC其他--引流傷口 總院', re: /引流傷口|傷口引流|傷口拭子|傷口|膿液/ },
    { code: 'CDCN0149', name: 'CDC其他--血 總院', re: /全血|血液(?!培養)|血(?!清|液培養)/ },
    { code: 'CDCN0155', name: 'CDC其他--痰 總院', re: /痰液|痰|下呼吸道檢體|呼吸道抽吸液|氣管抽吸液|BAL|支氣管肺泡沖洗液/ },
    { code: 'CDCN0161', name: 'CDC其他--口水 總院', re: /口水|唾液/ },
    { code: 'CDCN0150', name: 'CDC其他--血清 總院', re: /血清/ },
    { code: 'CDCN0156', name: 'CDC其他--嘔吐物 總院', re: /嘔吐物|嘔吐/ },
    { code: 'CDCN0162', name: 'CDC其他--水泡 總院', re: /水泡|水疱|疱液|水疱液/ },
    { code: 'CDCN0151', name: 'CDC其他--腦脊髓液 總院', re: /腦脊髓液|腦脊液|CSF/ },
    { code: 'CDCN0157', name: 'CDC其他--尿 總院', re: /尿液|尿/ },
    { code: 'CDCN0163', name: 'CDC其他--其他液狀檢體 總院', re: /其他液狀檢體|胸水|腹水|體液/ },
    { code: 'CDCN0152', name: 'CDC其他--糞 總院', re: /糞便|糞|大便|stool/i },
    { code: 'CDCN0158', name: 'CDC其他--關節液 總院', re: /關節液/ },
    { code: 'CDCN0164', name: 'CDC其他--組織 總院', re: /組織|切片|病理組織/ }
  ];
  const hits = [];
  const seen = {};
  orderMap.forEach(function(item) {
    if (item.code === 'CDCN0152' && /糞便拭子|肛門拭子|直腸拭子|肛拭子/.test(text)) return;
    if (item.re.test(text) && !seen[item.code]) {
      seen[item.code] = true;
      hits.push(item.code + ' ' + item.name);
    }
  });
  return hits.slice(0, 6).join('；');
}

function nextSubtopicPrompt_(diseaseName) {
  return '';
}

function searchKb_(question, limit) {
  const kb = loadKb_();
  const synonyms = kb.synonyms || {};
  const qTokens = expandTokens_(tokenize_(question), synonyms);
  const compactQuestion = question.replace(/\s+/g, '').toLowerCase();
  const detectedDisease = detectDisease_(question);
  const diseaseTerms = detectedDisease ? diseaseSearchTerms_(detectedDisease.name, synonyms) : [];
  const scored = [];

  kb.entries.forEach(function(entry) {
    if (isInternalPlanningSource_(entry.source) || isInternalPlanningSource_(entry.title)) return;
    const haystack = (entry.source + '\n' + entry.title + '\n' + entry.text).toLowerCase();
    const compactHaystack = haystack.replace(/\s+/g, '');
    if (diseaseTerms.length && !diseaseTerms.some(function(term) { return compactHaystack.indexOf(term) >= 0; })) return;

    // 嚴格疾病主體過濾：若問句為特定疾病（如兔熱病），排除非目標疾病（如黃熱病）的干擾
    if (/兔熱/i.test(compactQuestion) && !/黃熱/i.test(compactQuestion) && /黃熱/i.test(haystack) && !/兔熱/i.test(haystack)) {
      return;
    }
    if (/黃熱/i.test(compactQuestion) && !/兔熱/i.test(compactQuestion) && /兔熱/i.test(haystack) && !/黃熱/i.test(haystack)) {
      return;
    }

    let score = 0;
    qTokens.forEach(function(token) {
      if (haystack.indexOf(token) >= 0) score += token.length >= 3 ? 3 : 1;
      if (String(entry.title).toLowerCase().indexOf(token) >= 0) score += 5;
      if (String(entry.source).toLowerCase().indexOf(token) >= 0) score += 4;
    });
    if (compactQuestion && compactHaystack.indexOf(compactQuestion) >= 0) score += 20;
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
    lines.push('- ' + title);
  });
  return '您好！目前的關鍵字檢索命中度較低，為避免誤答，請嘗試補充更具體的項目（例如：通報流程、送驗檢體、隔離/解隔、疫區、清消濃度）。\n\n📌 可能相關主題：\n' +
    lines.join('\n') +
    '\n\n💡 提問範例：「VRE 隔離」、「麻疹 暴露」、「兔熱病 通報」';
}

function loadKb_() {
  if (KB_RUNTIME_CACHE_) return KB_RUNTIME_CACHE_;
  const cached = CacheService.getScriptCache().get('kb_index_v1');
  if (cached) {
    KB_RUNTIME_CACHE_ = JSON.parse(cached);
    return KB_RUNTIME_CACHE_;
  }

  const folderId = getProp_('KB_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName(CONFIG.KB_FILE_NAME);
  if (!files.hasNext()) throw new Error('Cannot find ' + CONFIG.KB_FILE_NAME);
  const text = files.next().getBlob().getDataAsString('UTF-8');
  const parsed = JSON.parse(text);
  KB_RUNTIME_CACHE_ = parsed;

  const slim = JSON.stringify(parsed);
  if (slim.length < 90000) {
    CacheService.getScriptCache().put('kb_index_v1', slim, 300);
  }
  return KB_RUNTIME_CACHE_;
}

function diseaseSearchTerms_(diseaseName, synonyms) {
  const canonical = String(diseaseName || '').replace(/\s+/g, '').toLowerCase();
  const values = (synonyms && synonyms[diseaseName]) || [];
  const terms = [canonical];
  values.forEach(function(value) {
    const term = String(value || '').replace(/\s+/g, '').toLowerCase();
    if (!term) return;
    const hasLatin = /[a-z]/i.test(term);
    if ((hasLatin && term.length >= 3) || (!hasLatin && term.length >= 3)) terms.push(term);
  });
  return terms.filter(function(term, index, all) { return term && all.indexOf(term) === index; });
}

function diseaseScopedExtractiveAnswer_(hits, diseaseName, subtopic) {
  const kb = loadKb_();
  const terms = diseaseSearchTerms_(diseaseName, kb.synonyms || {});
  const selected = [];
  const seen = {};
  (hits || []).forEach(function(entry) {
    const rawLines = [entry.title || ''].concat(String(entry.text || '').split('\n'));
    rawLines.forEach(function(raw, index) {
      const compact = String(raw || '').replace(/\s+/g, '').toLowerCase();
      if (!terms.some(function(term) { return compact.indexOf(term) >= 0; })) return;
      for (let offset = 0; offset < 4 && index + offset < rawLines.length; offset++) {
        const line = cleanKnowledgeLine_(rawLines[index + offset]);
        if (!line || seen[line]) continue;
        if (/\.md\b|問[「\"]|回答提醒|回答重點|不要主動|不要直接|優先查詢|知識庫中|本檔供|本文件|來源提示/i.test(line)) continue;
        seen[line] = true;
        selected.push(line);
      }
    });
  });
  if (subtopic === 'placement' && selected.some(function(line) { return /隔壁床住了隔離病人|同病室有隔離病人/.test(line); })) {
    return safeDiseaseSubtopicFallback_(diseaseName, subtopic);
  }
  if (!selected.length) return safeDiseaseSubtopicFallback_(diseaseName, subtopic);
  return diseaseName + '查詢重點：\n' + selected.slice(0, 7).map(function(line) { return '- ' + line; }).join('\n');
}

function loadAuditClauses_() {
  if (AUDIT_RUNTIME_CACHE_) return AUDIT_RUNTIME_CACHE_;
  const folderId = getProp_('KB_FOLDER_ID');
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName(CONFIG.AUDIT_FILE_NAME);
  if (!files.hasNext()) return { clauses: [] };
  AUDIT_RUNTIME_CACHE_ = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
  return AUDIT_RUNTIME_CACHE_;
}

function loadClearanceRules_() {
  if (CLEARANCE_RUNTIME_CACHE_) return CLEARANCE_RUNTIME_CACHE_;
  try {
    const folderId = getProp_('KB_FOLDER_ID');
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByName(CONFIG.CLEARANCE_FILE_NAME);
    if (!files.hasNext()) return { rules: {} };
    CLEARANCE_RUNTIME_CACHE_ = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
    return CLEARANCE_RUNTIME_CACHE_;
  } catch (err) {
    console.error('loadClearanceRules_ error: ' + err.toString());
    return { rules: {} };
  }
}

function buildContext_(hits, maxChars) {
  let context = '';
  hits.forEach(function(entry, index) {
    const block = '[' + (index + 1) + '] ' + entry.title + '\n來源：' + entry.source + '\n' + entry.text + '\n\n';
    if ((context + block).length <= maxChars) context += block;
  });
  return context;
}

function callGemini_(question, context, language) {
  const apiKey = getProp_('GEMINI_API_KEY', true);
  if (!apiKey) return '';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const lang = String(language || 'zh-TW');
  let languageRule = '請以繁體中文回答。';
  if (lang === 'en') languageRule = 'Please answer in clear, natural English. Use only the knowledge base content and do not add unsupported medical advice.';
  if (lang === 'id') languageRule = 'Jawablah dalam Bahasa Indonesia yang jelas dan ramah. Gunakan hanya isi basis pengetahuan dan jangan menambahkan nasihat medis tanpa dasar.';
  if (lang === 'vi') languageRule = 'Vui lòng trả lời bằng Tiếng Việt rõ ràng và thân thiện. Chỉ dùng nội dung trong kho kiến thức, không tự thêm lời khuyên y khoa không có căn cứ.';
  const prompt =
    '你是台大感管中心的 LINE 問答助手。請用專業、簡明、精準、親切的語氣回答。\n' +
    '語言規則：' + languageRule + '\n' +
    '【絕對禁止】：嚴禁輸出任何文件名稱、文件標題（如「全傳染病衛教與臨床處置大典」）、前言介紹（如「本文件為...」）或章節標題（如「第X部分...」）！\n' +
    '每一項醫療、隔離、清消、醫令、濃度、期限或操作事實，都必須能由下方知識庫內容直接支持；不得靠常識補寫、推測或混合不同疾病、單位、設備的內容。\n' +
    '若知識庫不足以回答問題，請明確回答「目前資料不足，無法確認」，並指出缺少哪一類正式資料；不要以相近主題代答。\n' +
    '嚴禁輸出 Markdown 標題符號（如 ### 或 ##），只輸出純粹可執行的臨床感控 SOP 內容。\n' +
    '控制在 4-8 行短條列內回答。\n' +
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

function isInternalPlanningSource_(value) {
  return /全傳染病線上互動平台|GitHubPages規格|串接規格|聊天機器人回答行為規則|9千列版回補/i.test(String(value || ''));
}

function translateAnswerForUserLanguage_(text, event, answerObj) {
  const lang = getUserLanguage_(event);
  if (!lang || lang === 'zh-TW') return text;
  if (answerObj && answerObj.languagePrompt) return text;
  const translated = callGeminiTranslate_(text, lang);
  return translated || text;
}

function callGeminiTranslate_(text, language) {
  const apiKey = getProp_('GEMINI_API_KEY', true);
  if (!apiKey) return '';
  const lang = String(language || 'zh-TW');
  const labels = {
    en: 'English',
    id: 'Bahasa Indonesia',
    vi: 'Tiếng Việt'
  };
  const target = labels[lang] || '';
  if (!target) return '';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const prompt =
    'Translate the following LINE bot answer into ' + target + '.\n' +
    'Rules:\n' +
    '- Translate only; do not add new medical facts, advice, sources, or warnings.\n' +
    '- Preserve all codes, URLs, percentages, ppm, dates, drug names, ANN codes, CDCN codes, and disease names when appropriate.\n' +
    '- Keep it concise and friendly for a hospital infection-control LINE bot.\n' +
    '- Do not use Markdown bold markers, code fences, or headings with ###.\n\n' +
    'Text:\n' + String(text || '');
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1400 },
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
  return parts && parts.length ? cleanAnswerText_(String(parts[0].text || '').trim()) : '';
}

function extractiveAnswer_(hits, targetDiseaseName) {
  const lines = [];
  const seen = {};

  (hits || []).slice(0, 3).forEach(function(entry) {
    const text = String(entry.text || '');
    text.split('\n').forEach(function(raw) {
      const line = cleanKnowledgeLine_(raw);
      if (!line || seen[line]) return;
      seen[line] = true;
      lines.push('   · ' + line);
    });
  });

  const content = lines.slice(0, 6).join('\n') || '   · 相關感管規範請依疾管署與院內最新 SOP 辦理。';
  return '📋 **感染管制處置與規範重點整理**：\n\n' + content + nextSubtopicPrompt_(targetDiseaseName || '本疾病');
}

function cleanAnswerText_(text) {
  let s = String(text || '');
  s = s.replace(/Coze\/LINE/gi, 'LINE');
  s = s.replace(/Coze/gi, '');
  s = s.replace(/\S+\.md/g, '');
  s = s.replace(/.*台大醫院感管中心\s*-\s*全傳染病衛教.*/gi, '');
  s = s.replace(/.*本文件為台大醫院感管中心.*/gi, '');
  s = s.replace(/.*權威核心文檔.*/gi, '');
  s = s.replace(/.*kb_index\.json.*/gi, '');
  s = s.replace(/.*第[一二三四五六七八九十]+部分[:：].*/gi, '');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/^\s*[-*]+\s*/gm, '- ');
  s = s.replace(/## 民眾版.*$/gm, '');
  s = s.replace(/【民眾版.*?】/g, '');
  s = s.split('\n').filter(function(line) {
    const cleaned = String(line || '').replace(/^\s*[-·•*]\s*/, '').trim();
    if (/[A-Z]:\\/i.test(cleaned)) return false;
    return !/(?:^|[；;。])\s*(?:民眾版|員工版|同仁版|回答重點|回答方向|建議回答|LINE 回答關鍵字|LINE 回答範例|若使用者問|若同仁問|只在使用者明確詢問|以下路徑只在|一般病人照護或民眾衛教回答不要|不要主動列出|查核佐證路徑與用途|你可以先做這幾件事|請用以下)/.test(cleaned);
  }).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return normalizeTravelLevelText_(s).trim();
}

function cleanKnowledgeLine_(raw) {
  let line = String(raw || '').trim();
  line = line
    .replace(/<a\b[^>]*>\s*<\/a>/gi, '')
    .replace(/＜a\b[^＞]*＞\s*＜\/a＞/gi, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*[-*]+\s*/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/Coze/gi, '')
    .trim();
  if (!line) return '';

  // 嚴格過濾知識庫文件內部標題、大典前言與系統宣告
  if (/全傳染病台大感管線上互動|全傳染病線上互動平台|GitHub Pages|GitHubPages|串接規格|本規劃案建立|互動式漂白水清消線上計算器|Web Calculator/.test(line)) return '';
  if (/台大醫院感管中心\s*-\s*全傳染病衛教|全傳染病衛教與臨床處置大典|權威核心文檔|kb_index\.json|Gemini RAG|第一線醫護決策支援/.test(line)) return '';
  if (/^(本文件為|本檔依|本檔供|整理時間|整理規則|排除項目|資料最新發布日期|資料來源|檢索關鍵字|LINE 查詢建議|LINE 問答關鍵字|查核佐證路徑與用途|地區清單：?$|請上傳所有同名前綴|適用情境：?|核心原則：?|回答重點：?|回答方向：?|建議回答：?|建議回答臨床同仁：?|回答時：?|若使用者問|若同仁問|只在使用者明確詢問|以下路徑只在|民眾版：?|員工版：?|同仁版：?|你可以先做這幾件事：?|請用以下|可給外籍病人的英文說法：?|LINE 回答範例：?)/.test(line)) return '';
  if (/一般病人照護或民眾衛教回答不要|不要主動列出|[A-Z]:\\/i.test(line)) return '';
  if (/(?:回答重點|回答方向|建議回答|LINE 回答關鍵字|LINE 回答範例|若使用者問|若同仁問)[:：]?/.test(line)) return '';
  if (/^(提醒：)?請不要在 LINE 輸入|^提醒不要在 LINE 輸入|^LINE 不可輸入個資|避免在 LINE 輸入個資/.test(line)) return '';
  if (/(第[一二三四五六七八九十]+部分[:：]|權威連結|大典|文檔之權威核心)/.test(line)) return '';
  if (/^(外籍病人、旅客或即將出境病人的法定傳染病通報|複合型問題：)/.test(line)) return '';
  if (/^本檔提供|^問[:：]|^答[:：]/.test(line)) return '';
  return normalizeTravelLevelText_(line);
}

function replyToLine_(replyToken, text, diseaseName, answerObj) {
  const token = getProp_('LINE_CHANNEL_ACCESS_TOKEN');
  const messageObj = {
    type: 'text',
    text: truncateLine_(sanitizeLineText_(normalizeTravelLevelText_(text)))
  };

  const quickReply = buildQuickReplyForDisease_(diseaseName, answerObj);
  if (quickReply) {
    messageObj.quickReply = quickReply;
  }
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [messageObj],
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    console.error('LINE Reply Error: ' + res.getContentText());
  }
}

function sanitizeLineText_(text) {
  return String(text || '')
    .split('\n')
    .filter(function(line) {
      const value = String(line || '');
      if (/[A-Z]:\\/i.test(value)) return false;
      if (/以下路徑只在使用者明確詢問|查核佐證路徑與用途|院內磁碟路徑/.test(value)) return false;
      return true;
    })
    .join('\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function buildQuickReplyForDisease_(diseaseName, answerObj) {
  const d = String(diseaseName || '').trim();
  const isStaff = answerObj && answerObj.identity === 'staff';
  let items = [];
  if (answerObj && answerObj.reportingPrompt) {
    items = [
      quickReplyMessage_('麻疹通報', '麻疹通報定義'),
      quickReplyMessage_('登革熱通報', '登革熱通報定義'),
      quickReplyMessage_('結核病通報', '結核病通報定義'),
      quickReplyMessage_('採檢送驗', '麻疹採檢送驗')
    ];
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (answerObj && answerObj.influenzaRiskPrompt) {
    items = [
      quickReplyMessage_('有症狀＋有接觸', '流感快篩陽性、PCR陰性；有類流感症狀；是新冠接觸者'),
      quickReplyMessage_('有症狀＋無接觸', '流感快篩陽性、PCR陰性；有類流感症狀；不是新冠接觸者'),
      quickReplyMessage_('無症狀＋有接觸', '流感快篩陽性、PCR陰性；無症狀；是新冠接觸者'),
      quickReplyMessage_('無症狀＋無接觸', '流感快篩陽性、PCR陰性；無症狀；不是新冠接觸者')
    ];
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (answerObj && answerObj.catheterPrompt) {
    items = [
      quickReplyMessage_('中心導管', '中心導管照護'),
      quickReplyMessage_('導尿管', '導尿管照護'),
      quickReplyMessage_('呼吸器', '呼吸器管路照護')
    ];
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (answerObj && answerObj.languagePrompt) {
    items = [
      quickReplyMessage_('繁體中文', '繁體中文'),
      quickReplyMessage_('English', 'English'),
      quickReplyMessage_('Bahasa', 'Bahasa Indonesia'),
      quickReplyMessage_('Tiếng Việt', 'Tiếng Việt')
    ].concat(items);
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (answerObj && answerObj.qualityPrompt) {
    items = items.concat([
      quickReplyMessage_('非常有幫助', '滿意度1'),
      quickReplyMessage_('有幫助', '滿意度2'),
      quickReplyMessage_('部分有幫助', '滿意度3'),
      quickReplyMessage_('幫助不大', '滿意度4'),
      quickReplyMessage_('沒有幫助', '滿意度5')
    ]);
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  const contextualItems = contextualQuickReplyItems_(answerObj);
  if (contextualItems.length) {
    return { items: appendGlobalQuickReplies_(contextualItems, answerObj) };
  }
  if (d === '會議檢索') {
    if (isStaff) {
      items = items.concat([
        quickReplyMessage_('週會議題', '感染月報在哪些週會出現'),
        quickReplyMessage_('月會議題', 'VRE在哪些月會出現'),
        quickReplyMessage_('查核佐證', '手部衛生查核佐證')
      ]);
    } else {
      items = items.concat([
        quickReplyMessage_('可以查什麼', '可以查什麼'),
        quickReplyMessage_('疫情資訊', '伊波拉疫區'),
        quickReplyMessage_('感染管制', '登革熱感染管制')
      ]);
    }
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (d === '閒聊') {
    items = items.concat([
      quickReplyMessage_('可以查什麼', '可以查什麼'),
      quickReplyMessage_('VRE解隔', 'VRE解隔')
    ]);
    if (isStaff) items.push(quickReplyMessage_('會議檢索', '會議檢索'));
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }
  if (!d || d === '熱門感控' || d === '本疾病' || d === '模式切換') {
    if (answerObj && answerObj.clarification) {
      const sub = String(answerObj.subtopic || '');
      let clarifyItems = [];
      if (sub === 'clearance') {
        clarifyItems = [
          quickReplyMessage_('VRE解隔', 'VRE解隔'),
          quickReplyMessage_('CRE解隔', 'CRE解隔'),
          quickReplyMessage_('流感解隔', '流感解隔'),
          quickReplyMessage_('水痘解隔', '水痘解隔')
        ];
      } else if (sub === 'definition') {
        clarifyItems = [
          quickReplyMessage_('麻疹通報定義', '麻疹通報定義'),
          quickReplyMessage_('未定型肝炎', '未定型肝炎通報定義'),
          quickReplyMessage_('新型A流通報', '新型A型流感通報定義'),
          quickReplyMessage_('百日咳定義', '百日咳通報定義')
        ];
      } else if (sub === 'specimen') {
        clarifyItems = [
          quickReplyMessage_('日腦採檢', '日腦採檢'),
          quickReplyMessage_('流腦採檢', '流腦採檢'),
          quickReplyMessage_('登革熱採檢', '登革熱採檢'),
          quickReplyMessage_('MDRO採檢', 'MDRO採檢')
        ];
      } else {
        clarifyItems = [
          quickReplyMessage_('登革熱隔離', '登革熱隔離醫囑'),
          quickReplyMessage_('VRE安置', 'VRE病人安置'),
          quickReplyMessage_('麻疹暴露', '麻疹暴露'),
          quickReplyMessage_('透析室清消', '透析室清消')
        ];
      }
      return { items: appendGlobalQuickReplies_(items.concat(clarifyItems), answerObj) };
    }
    return { items: appendGlobalQuickReplies_(items, answerObj) };
  }

  const currentSubtopic = answerObj && answerObj.subtopic ? String(answerObj.subtopic) : '';
  const candidates = [
    { key: 'definition', item: quickReplyMessage_('通報定義', d + '通報定義') },
    { key: 'isolation', item: quickReplyMessage_('隔離醫囑', d + '隔離醫囑') },
    { key: 'placement', item: quickReplyMessage_('病人安置', d + '病人安置') },
    { key: 'specimen', item: quickReplyMessage_('採檢送驗', d + '採檢送驗') },
    { key: 'care', item: quickReplyMessage_('PPE防護', d + 'PPE') },
    { key: 'sanitization', item: quickReplyMessage_('清消', d + '清消') },
    { key: 'clearance', item: quickReplyMessage_('解隔標準', d + '解隔標準') }
  ];
  const diseaseItems = candidates
    .filter(function(row) { return row.key !== currentSubtopic; })
    .map(function(row) { return row.item; });
  if (/^(麻疹|百日咳|HIV|針扎與體液暴露)$/.test(d)) {
    if (currentSubtopic !== 'exposure') diseaseItems.push(quickReplyMessage_('暴露處置', d + '暴露'));
  }
  return { items: appendGlobalQuickReplies_(items.concat(diseaseItems), answerObj) };
}

function contextualQuickReplyItems_(answerObj) {
  const q = String(answerObj && (answerObj.effectiveQuestion || answerObj.originalQuestion) || '');
  if (answerObj && answerObj.cjdAuditPrompt) {
    return [
      quickReplyMessage_('院內勾稽紀錄', 'CJD 院內系統勾稽紀錄怎麼查'),
      quickReplyMessage_('手動勾稽', 'CJD 疾管署手動勾稽怎麼查'),
      quickReplyMessage_('風險判定', 'CJD 病人要做鼻腔手術怎麼辦'),
      quickReplyMessage_('器械處理', 'CJD 病人鼻腔內視鏡或手術器械要怎麼處理'),
      quickReplyMessage_('KM佐證', 'CJD KM佐證')
    ];
  }
  if (answerObj && answerObj.auditTopicMenu === 'antibiotic') {
    return [
      quickReplyMessage_('計畫與權責', '查核條文 3.1 重點'),
      quickReplyMessage_('使用監測', '查核條文 3.2 重點'),
      quickReplyMessage_('抗藥性防治', '查核條文 3.3 重點'),
      quickReplyMessage_('手術預防用藥', '查核條文 3.2 手術預防性抗生素')
    ];
  }
  if (answerObj && answerObj.auditTopicMenu === 'epidemic-policy') {
    return [
      quickReplyMessage_('手冊與疫情', '查核條文 1.3 重點'),
      quickReplyMessage_('隔離與應變', '查核條文 1.5 重點'),
      quickReplyMessage_('傳染病通報', '查核條文 4.1 重點'),
      quickReplyMessage_('防疫物資', '查核條文 4.6 重點'),
      quickReplyMessage_('員工保護', '查核條文 5.1 重點')
    ];
  }
  const isNeedlestickAudit = answerObj && answerObj.mode === 'audit' && (
    String(answerObj.auditClauseId || '') === '5.2' ||
    String(answerObj.diseaseName || '') === '針扎與體液暴露' ||
    /針扎|針刺|尖銳物|血液體液暴露|職業暴露|HIV\s*PEP/i.test(q)
  );
  if (isNeedlestickAudit) {
    return [
      quickReplyMessage_('立即處理', '針扎暴露後立即處理'),
      quickReplyMessage_('HIV PEP', '針扎 HIV PEP'),
      quickReplyMessage_('檢驗追蹤', '針扎檢驗與追蹤'),
      quickReplyMessage_('委員提問', '查核條文 5.2 委員提問'),
      quickReplyMessage_('KM佐證', '查核條文 5.2 KM佐證')
    ];
  }
  if (answerObj && answerObj.auditClauseId) {
    const clauseId = String(answerObj.auditClauseId);
    return [
      quickReplyMessage_('條文重點', '查核條文 ' + clauseId + ' 重點'),
      quickReplyMessage_('委員提問', '查核條文 ' + clauseId + ' 委員提問'),
      quickReplyMessage_('KM佐證', '查核條文 ' + clauseId + ' KM佐證')
    ];
  }
  if (answerObj && answerObj.mode === 'audit' && answerObj.diseaseName && answerObj.diseaseName !== '評鑑查核') {
    const topic = String(answerObj.diseaseName);
    const subtopic = String(answerObj.subtopic || '');
    if (topic === '透析室') {
      return [
        quickReplyMessage_('清消標準', '透析室消毒濃度'),
        quickReplyMessage_('委員提問', '透析室清消委員提問'),
        quickReplyMessage_('執行紀錄', '透析室清消可出示紀錄'),
        quickReplyMessage_('KM佐證', '透析室清消KM佐證')
      ];
    }
    if (subtopic === 'definition') {
      return [
        quickReplyMessage_('通報重點', topic + '通報定義'),
        quickReplyMessage_('採檢佐證', topic + '採檢送驗'),
        quickReplyMessage_('委員提問', topic + '通報委員提問'),
        quickReplyMessage_('KM佐證', topic + '通報KM佐證')
      ];
    }
    return [
      quickReplyMessage_('委員提問', topic + '評鑑委員可能提問'),
      quickReplyMessage_('KM佐證', topic + 'KM佐證'),
      quickReplyMessage_('執行紀錄', topic + '可出示執行紀錄'),
      quickReplyMessage_('處置重點', topic + '感染管制處置重點')
    ];
  }
  if (/教育|訓練/i.test(q) && answerObj && answerObj.mode === 'audit') {
    return [
      quickReplyMessage_('教育時數', '感染管制教育時數'),
      quickReplyMessage_('完訓紀錄', '感染管制教育完訓紀錄佐證'),
      quickReplyMessage_('新進人員', '新進人員感染管制教育查核'),
      quickReplyMessage_('高風險作業', '高風險作業人員教育與技術查核')
    ];
  }
  if (/疫苗|預防接種|抗體/i.test(q) && answerObj && answerObj.mode === 'audit') {
    return [
      quickReplyMessage_('適用對象', '疫苗政策適用對象'),
      quickReplyMessage_('接種與抗體', '疫苗接種與抗體紀錄佐證'),
      quickReplyMessage_('未接種追蹤', '疫苗未接種與禁忌追蹤'),
      quickReplyMessage_('外包實習', '外包與實習人員疫苗政策')
    ];
  }
  if (/內視鏡/i.test(q)) {
    return [
      quickReplyMessage_('再處理流程', '內視鏡再處理流程'),
      quickReplyMessage_('手工清洗', '內視鏡手工清洗'),
      quickReplyMessage_('高層次消毒', '內視鏡高層次消毒'),
      quickReplyMessage_('乾燥與儲存', '內視鏡乾燥與儲存'),
      quickReplyMessage_('異常監測', '內視鏡微生物監測異常')
    ];
  }
  return [];
}

function globalQuickReplyItems_(showSatisfaction, activeMode) {
  const items = [
    {
      type: 'action',
      action: {
        type: 'uri',
        label: '疫情訊息',
        uri: latestEpidemicInfoUrl_()
      }
    }
  ];
  if (activeMode !== 'audit') items.push(quickReplyMessage_('評鑑查核', '評鑑查核'));
  if (activeMode !== 'clinical') items.push(quickReplyMessage_('臨床照護', '臨床照護'));
  if (showSatisfaction) {
    items.push(quickReplyMessage_('滿意度', '滿意度'));
  } else {
    items.push(quickReplyMessage_('🔒滿意度', '🔒滿意度'));
  }
  items.push(quickReplyMessage_('感管意見箱', '感管意見箱'));
  return items;
}

function appendGlobalQuickReplies_(items, answerObj) {
  const showSatisfaction = Boolean(answerObj && (answerObj.qualityPrompt || answerObj.satisfactionEligible));
  const activeMode = answerObj && answerObj.modeExplicit ? String(answerObj.mode || '') : '';
  const base = globalQuickReplyItems_(showSatisfaction, activeMode);
  return (items || []).slice(0, 13 - base.length).concat(base);
}

function quickReplyUri_(label, uri) {
  return {
    type: 'action',
    action: {
      type: 'uri',
      label: String(label || '').slice(0, 20),
      uri: String(uri || '')
    }
  };
}

function quickReplyMessage_(label, text) {
  return {
    type: 'action',
    action: {
      type: 'message',
      label: String(label || '').slice(0, 20),
      text: String(text || '').slice(0, 300)
    }
  };
}

function latestEpidemicInfoUrl_() {
  return 'https://heigilin.github.io/ntuh_cdc/web-preview.html';
}

function normalizeTravelLevelText_(text) {
  let s = String(text || '');
  s = s.replace(/第三級[:：]\s*警告\s*[（(]\s*Warning\s*[）)]/gi, '🔴 第三級：警告');
  s = s.replace(/第二級[:：]\s*警示\s*[（(]\s*Alert\s*[）)]/gi, '🟠 第二級：警示');
  s = s.replace(/第一級[:：]\s*注意\s*[（(]\s*Watch\s*[）)]/gi, '🟡 第一級：注意');
  s = s.replace(/第三級[:：]\s*警告/gi, '🔴 第三級：警告');
  s = s.replace(/第二級[:：]\s*警示/gi, '🟠 第二級：警示');
  s = s.replace(/第一級[:：]\s*注意/gi, '🟡 第一級：注意');
  s = s.replace(/（Warning）|\(Warning\)/gi, '');
  s = s.replace(/（Alert）|\(Alert\)/gi, '');
  s = s.replace(/（Watch）|\(Watch\)/gi, '');
  s = s.replace(/🔴\s*🔴/g, '🔴');
  s = s.replace(/🟠\s*🟠/g, '🟠');
  s = s.replace(/🟡\s*🟡/g, '🟡');
  return s;
}

function convertFullWidthToHalfWidth_(str) {
  if (!str) return '';
  let result = '';
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      result += String.fromCharCode(code - 65248);
    } else if (code === 0x3000) {
      result += ' ';
    } else {
      result += str.charAt(i);
    }
  }
  return result;
}

function tokenize_(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = [];
  const latin = lower.match(/[a-z0-9][a-z0-9_\-\.\/\+%]*/g) || [];
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

function getProp_(name, optional) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value && !optional) throw new Error('Missing script property: ' + name);
  return (value || '').trim().replace(/^[\x22\x27]|[\x22\x27]$/g, '');
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

function testSendLineMessage() {
  const resultObj = answerQuestion_("兔熱病");
  console.log("=== 測試生成的兔熱病答覆 ===");
  console.log(resultObj.text);
  const quickReply = buildQuickReplyForDisease_(resultObj.diseaseName);
  console.log("=== 測試生成的 LINE 浮動快捷導覽按鈕 (Quick Reply) ===");
  console.log(JSON.stringify(quickReply));
  const token = getProp_('LINE_CHANNEL_ACCESS_TOKEN', true);
  console.log("LINE_CHANNEL_ACCESS_TOKEN status: " + (token ? "Configured len " + token.length : "Missing"));
}

function testSendRealLineMessageToMe() {
  const token = getProp_('LINE_CHANNEL_ACCESS_TOKEN');
  console.log('Testing direct API connection to LINE Messaging API...');
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  console.log('LINE Bot Info API HTTP Status: ' + res.getResponseCode());
  console.log('LINE Bot Info Response: ' + res.getContentText());
}
