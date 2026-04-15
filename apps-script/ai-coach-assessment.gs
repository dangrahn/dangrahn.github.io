// Google Apps Script backend for the AI Coach readiness assessment on danielgrahn.com.
// Deployed as a web app, it receives assessment answers, fetches the visitor's LinkedIn
// profile, calls Claude API to generate personalized AI opportunity insights, and sends
// a notification email with the lead details.

var OWNER_EMAIL = 'dangrahn@gmail.com'

var ROLE_LABELS = {
  strategy: 'Strategy & decision-making',
  content: 'Creating content, documents, or presentations',
  data: 'Analyzing data, reports, or research',
  coordination: 'Coordinating people, projects, or processes',
  building: 'Building or designing products'
}
var TIME_DRAIN_LABELS = {
  communication: 'Emails, messages, and status updates',
  meetings: 'Meetings, notes, and follow-ups',
  research: 'Searching for info or compiling reports',
  reviewing: 'Reviewing, editing, or formatting documents',
  dataEntry: 'Manual data entry or moving data between tools'
}
var AI_USAGE_LABELS = {
  none: "Haven't really started yet",
  occasional: 'Occasional ChatGPT for writing or brainstorming',
  regular: 'Regular use of one AI tool for specific tasks',
  multiple: 'Multiple AI tools in my workflow',
  advanced: 'Building custom automations or AI agents'
}
var BLOCKER_LABELS = {
  unsure: "Not sure where to start or what's possible",
  privacy: 'Data privacy or security concerns',
  time: 'Hard to find time to learn and experiment',
  tools: "The tools I've tried didn't stick",
  organization: "My organization hasn't adopted AI yet"
}

function handleAssessment(body) {
  var validationError = validateInput(body)
  if (validationError) return jsonResponse(validationError)

  var insights = callClaude(body)

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

function callClaude(answers) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')
  if (!apiKey) return { error: 'missing_api_key' }

  var prompt = buildPrompt(answers)

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

function buildPrompt(answers) {
  return [
    "You are an AI coaching assessment engine. Your job is to deliver a personalized AI opportunity analysis that creates a genuine aha moment.",
    '',
    '## This person',
    '- Name: ' + answers.name,
    '- Job title: ' + answers.jobTitle,
    '- Company: ' + answers.company,
    '',
    'Use web search to look up their company (' + answers.company + ') to understand what it does, its industry, size, and products/services. This context is essential for making insights specific.',
    '',
    '## Questionnaire answers',
    '- Roles: ' + resolveSelections(answers.role, ROLE_LABELS),
    '- Biggest time drains: ' + resolveSelections(answers.timeDrain, TIME_DRAIN_LABELS),
    '- Current AI usage: ' + (AI_USAGE_LABELS[answers.aiUsage] || answers.aiUsage),
    '- Blockers: ' + resolveSelections(answers.blocker, BLOCKER_LABELS),
    '',
    '## Step 3: Generate the assessment',
    '',
    'RULES:',
    '- ALWAYS write in second person ("you", "your"). Never refer to the person by name or in third person ("he", "she", "they", "Filip likely...").',
    '- ALWAYS mention their actual job title and company name in the insights. Every insight must reference their real context.',
    '- Never use vague phrases like "in your industry" or "at your company" — name the specific industry, company, and role.',
    '- The profileLabel must include or reference their actual role (e.g. for a CTO at Acme: "AI-Ready CTO", not "Tech Strategist").',
    '- Think about what someone in THAT exact role at THAT exact company would spend their time on, and how AI would change that.',
    '',
    'The goal: they read this and think "this person understands exactly what I do every day." That aha moment makes them want to book an AI coaching session.',
    '',
    'Return ONLY a JSON object (no markdown, no explanation) with exactly this structure:',
    '{',
    '  "profileLabel": "2-4 words incorporating their ACTUAL role (e.g. \'AI-Ready CTO\', \'Untapped VP of Sales\')",',
    '  "readinessLevel": <number 1-5>,',
    '  "opportunities": [',
    '    "Short, punchy opportunity specific to their role at their company — max 1-2 sentences. Mention their company/role by name.",',
    '    "Another concrete opportunity — what AI could automate or accelerate in their specific workflow",',
    '    "A third opportunity — reference what peers in their industry are already doing with AI"',
    '  ],',
    '  "nextStep": "One sentence suggesting an AI coaching session and what it could specifically help them with based on their role and company. Never mention Daniel by name. Use \'you\' not their name."',
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

