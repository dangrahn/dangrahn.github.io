// Google Apps Script backend for the AI Competence Development readiness assessment on danielgrahn.com.
// Deployed as a web app, it receives assessment answers, fetches the visitor's LinkedIn
// profile, calls Claude API to generate personalized AI opportunity insights, and sends
// a notification email with the lead details.

var OWNER_EMAIL = 'dangrahn@gmail.com'

var ASSESSMENT_TEXTS = {
  en: {
    promptLang: '',
    secondPerson: '"you", "your"',
    roleLabels: {
      strategy: 'Strategy & decision-making',
      content: 'Creating content, documents, or presentations',
      data: 'Analyzing data, reports, or research',
      coordination: 'Coordinating people, projects, or processes',
      building: 'Building or designing products',
    },
    timeDrainLabels: {
      communication: 'Emails, messages, and status updates',
      meetings: 'Meetings, notes, and follow-ups',
      research: 'Searching for info or compiling reports',
      reviewing: 'Reviewing, editing, or formatting documents',
      dataEntry: 'Manual data entry or moving data between tools',
    },
    aiUsageLabels: {
      none: "Haven't really started yet",
      occasional: 'Occasional ChatGPT for writing or brainstorming',
      regular: 'Regular use of one AI tool for specific tasks',
      multiple: 'Multiple AI tools in my workflow',
      advanced: 'Building custom automations or AI agents',
    },
    blockerLabels: {
      unsure: "Not sure where to start or what's possible",
      privacy: 'Data privacy or security concerns',
      time: 'Hard to find time to learn and experiment',
      tools: "The tools I've tried didn't stick",
      organization: "My organization hasn't adopted AI yet",
    },
  },
  sv: {
    promptLang: '\n\nIMPORTANT: Write ALL output text (profileLabel, opportunities, nextStep) in Swedish. The JSON keys must remain in English, but all string values must be in Swedish. Use Swedish second person ("du", "din", "ditt").\n',
    secondPerson: '"du", "din", "ditt"',
    roleLabels: {
      strategy: 'Strategi och beslutsfattande',
      content: 'Skapa inneh\u00e5ll, dokument eller presentationer',
      data: 'Analysera data, rapporter eller research',
      coordination: 'Koordinera m\u00e4nniskor, projekt eller processer',
      building: 'Bygga eller designa produkter',
    },
    timeDrainLabels: {
      communication: 'E-post, meddelanden och statusuppdateringar',
      meetings: 'M\u00f6ten, anteckningar och uppf\u00f6ljningar',
      research: 'S\u00f6ka information eller sammanst\u00e4lla rapporter',
      reviewing: 'Granska, redigera eller formatera dokument',
      dataEntry: 'Manuell datainmatning eller flytta data mellan verktyg',
    },
    aiUsageLabels: {
      none: 'Har inte riktigt b\u00f6rjat \u00e4nnu',
      occasional: 'Anv\u00e4nder ChatGPT ibland f\u00f6r skrivande eller brainstorming',
      regular: 'Regelbunden anv\u00e4ndning av ett AI-verktyg f\u00f6r specifika uppgifter',
      multiple: 'Flera AI-verktyg i mitt arbetsfl\u00f6de',
      advanced: 'Bygger egna automationer eller AI-agenter',
    },
    blockerLabels: {
      unsure: 'Os\u00e4ker p\u00e5 var jag ska b\u00f6rja eller vad som \u00e4r m\u00f6jligt',
      privacy: 'Oro kring datas\u00e4kerhet eller integritet',
      time: 'Sv\u00e5rt att hitta tid att l\u00e4ra sig och experimentera',
      tools: 'Verktygen jag provat har inte fastnat',
      organization: 'Min organisation har inte b\u00f6rjat med AI \u00e4nnu',
    },
  },
}

function getAssessmentTexts(lang) {
  return ASSESSMENT_TEXTS[lang] || ASSESSMENT_TEXTS.en
}

function handleAssessment(body) {
  var validationError = validateInput(body)
  if (validationError) return jsonResponse(validationError)

  var lang = body.lang || 'en'
  var insights = callClaude(body, lang)

  if (insights.error) {
    return jsonResponse({ error: 'analysis_failed', message: 'Analysis failed: ' + insights.error })
  }

  try { notifyAssessmentOwner(body, insights) } catch (e) { Logger.log('Notification failed: ' + e) }

  return jsonResponse({ success: true, insights: insights })
}

function validateInput(body) {
  if (!body.name || !body.jobTitle || !body.company) {
    return { error: 'invalid_input', message: 'Name, job title, and company are required.' }
  }
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return { error: 'invalid_input', message: 'A valid email address is required.' }
  }
  var multiFields = ['role', 'timeDrain', 'blocker']
  for (var i = 0; i < multiFields.length; i++) {
    var val = body[multiFields[i]]
    if (!val || !Array.isArray(val) || val.length === 0) {
      return { error: 'invalid_input', message: 'All questions must have at least one selection.' }
    }
  }
  if (!body.aiUsage) {
    return { error: 'invalid_input', message: 'AI usage question is required.' }
  }
  return null
}

function callClaude(answers, lang) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')
  if (!apiKey) return { error: 'missing_api_key' }

  var prompt = buildPrompt(answers, lang)

  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages: [{ role: 'user', content: prompt }]
      }),
      muteHttpExceptions: true
    })

    var data = JSON.parse(response.getContentText())
    if (data.error) return { error: data.error.message }

    var textBlocks = data.content.filter(function(b) { return b.type === 'text' })
    if (textBlocks.length === 0) return { error: 'no_text_response' }

    var allText = textBlocks.map(function(b) { return b.text }).join('\n')
    var jsonMatch = allText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { error: 'invalid_response: ' + allText.substring(0, 200) }

    return JSON.parse(jsonMatch[0])
  } catch (e) {
    return { error: e.message }
  }
}

function resolveSelections(values, labelMap) {
  return values.map(function(v) {
    if (v.indexOf('other:') === 0) return v.substring(6)
    return labelMap[v] || v
  }).join(', ')
}

function buildPrompt(answers, lang) {
  var texts = getAssessmentTexts(lang)

  return [
    "You are an AI competence development assessment engine. Your job is to deliver a personalized AI opportunity analysis that creates a genuine aha moment.",
    '',
    '## This person',
    '- Name: ' + answers.name,
    '- Job title: ' + answers.jobTitle,
    '- Company: ' + answers.company,
    '',
    'Use web search to look up their company (' + answers.company + ') to understand what it does, its industry, size, and products/services. This context is essential for making insights specific.',
    '',
    '## Questionnaire answers',
    '- Roles: ' + resolveSelections(answers.role, texts.roleLabels),
    '- Biggest time drains: ' + resolveSelections(answers.timeDrain, texts.timeDrainLabels),
    '- Current AI usage: ' + (texts.aiUsageLabels[answers.aiUsage] || answers.aiUsage),
    '- Blockers: ' + resolveSelections(answers.blocker, texts.blockerLabels),
    '',
    '## Step 3: Generate the assessment',
    '',
    'RULES:',
    '- ALWAYS write in second person (' + texts.secondPerson + '). Never refer to the person by name or in third person ("he", "she", "they", "Filip likely...").',
    '- ALWAYS mention their actual job title and company name in the insights. Every insight must reference their real context.',
    '- Never use vague phrases like "in your industry" or "at your company" \u2014 name the specific industry, company, and role.',
    '- The profileLabel must include or reference their actual role (e.g. for a CTO at Acme: "AI-Ready CTO", not "Tech Strategist").',
    '- Think about what someone in THAT exact role at THAT exact company would spend their time on, and how AI would change that.',
    '',
    'The goal: they read this and think "this person understands exactly what I do every day." That aha moment makes them want to book an AI competence development session.',
    texts.promptLang,
    'Return ONLY a JSON object (no markdown, no explanation) with exactly this structure:',
    '{',
    '  "profileLabel": "2-4 words incorporating their ACTUAL role (e.g. \'AI-Ready CTO\', \'Untapped VP of Sales\')",',
    '  "readinessLevel": <number 1-5>,',
    '  "opportunities": [',
    '    "Short, punchy opportunity specific to their role at their company \u2014 max 1-2 sentences. Mention their company/role by name.",',
    '    "Another concrete opportunity \u2014 what AI could automate or accelerate in their specific workflow",',
    '    "A third opportunity \u2014 reference what peers in their industry are already doing with AI"',
    '  ],',
    '  "nextStep": "One sentence suggesting an AI competence development session and what it could specifically help them with based on their role and company. Never mention Daniel by name. Use second person, not their name."',
    '}'
  ].join('\n')
}

function formatField(value) {
  return Array.isArray(value) ? value.join(', ') : value
}

function notifyAssessmentOwner(body, insights) {
  var subject = 'New AI Assessment: ' + (insights.profileLabel || 'Unknown') + ' \u2014 ' + body.name + ' (' + body.email + ')'

  var emailBody = [
    'New AI readiness assessment completed!',
    '',
    'Name: ' + body.name,
    'Email: ' + (body.email || 'N/A'),
    'Job title: ' + body.jobTitle,
    'Company: ' + body.company,
    'Readiness: ' + insights.readinessLevel + '/5 (' + insights.profileLabel + ')',
    '',
    'Answers:',
    '  Role: ' + formatField(body.role),
    '  Time drain: ' + formatField(body.timeDrain),
    '  AI usage: ' + formatField(body.aiUsage),
    '  Blocker: ' + formatField(body.blocker),
    '',
    'Opportunities:',
    insights.opportunities ? insights.opportunities.map(function(s) { return '  - ' + s }).join('\n') : 'N/A',
    '',
    'Next step recommendation: ' + (insights.nextStep || 'N/A')
  ].join('\n')

  MailApp.sendEmail(OWNER_EMAIL, subject, emailBody)
}
