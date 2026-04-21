// Google Apps Script backend for the AI Competence Development booking page on danielgrahn.com.
// Deployed as a web app, it exposes availability from the primary Google Calendar
// and creates competence development session bookings with email notifications.

const TIMEZONE = 'Europe/Stockholm'
const BUSY_CALENDARS = ['dangrahn@gmail.com']
var SLOTS = [
  { time: '09:00', hours: 9, minutes: 0, duration: 2 },
  { time: '13:00', hours: 13, minutes: 0, duration: 2 },
]
var INTRO_SLOTS = [
  { time: '09:00', hours: 9, minutes: 0, duration: 0.5 },
  { time: '09:30', hours: 9, minutes: 30, duration: 0.5 },
  { time: '10:00', hours: 10, minutes: 0, duration: 0.5 },
  { time: '10:30', hours: 10, minutes: 30, duration: 0.5 },
  { time: '11:00', hours: 11, minutes: 0, duration: 0.5 },
  { time: '13:00', hours: 13, minutes: 0, duration: 0.5 },
  { time: '13:30', hours: 13, minutes: 30, duration: 0.5 },
  { time: '14:00', hours: 14, minutes: 0, duration: 0.5 },
  { time: '14:30', hours: 14, minutes: 30, duration: 0.5 },
]
const MIN_LEAD_DAYS = 5
const MAX_WEEKS_AHEAD = 6

var BOOKING_TEXTS = {
  en: {
    eventTitle: 'AI Competence Development Session',
    inviteGreeting: "I'm glad you booked a competence development session and look forward to our meeting!",
    invitePrep: 'Before our session you will receive a preparation questionnaire to fill in. This is the only preparation and it only takes 5 minutes.',
    inviteClosing: 'Looking forward to our meeting and to helping you leverage AI in your daily work!',
    slotTaken: 'This slot was just booked. Please select another.',
    bookingConfirmed: 'Booking confirmed.',
    promptLang: '',
    packageSingle: 'Single meeting',
    packageBundle: '3-meeting program',
    packageIntro: 'Free intro call',
    introEventTitle: 'AI Competence Development \u2014 Intro Call',
    introInviteGreeting: "Thanks for booking an intro call \u2014 I look forward to our conversation!",
    introInviteBody: "We'll have a casual 30-minute chat about your workflow and how AI might help. No preparation needed.",
  },
  sv: {
    eventTitle: 'AI-kompetensutvecklingssession',
    inviteGreeting: 'Vad roligt att du bokat en kompetensutvecklingssession \u2014 jag ser fram emot v\u00e5rt m\u00f6te!',
    invitePrep: 'Innan sessionen kommer du att f\u00e5 ett f\u00f6rberedelseformul\u00e4r att fylla i. Det \u00e4r den enda f\u00f6rberedelsen och tar bara 5 minuter.',
    inviteClosing: 'Ser fram emot att hj\u00e4lpa dig dra nytta av AI i ditt dagliga arbete!',
    slotTaken: 'Den h\u00e4r tiden bokades just. V\u00e4nligen v\u00e4lj en annan.',
    bookingConfirmed: 'Bokning bekr\u00e4ftad.',
    promptLang: '',
    packageSingle: 'Enstaka m\u00f6te',
    packageBundle: '3-m\u00f6tespaket',
    packageIntro: 'Kostnadsfritt introduktionssamtal',
    introEventTitle: 'AI-kompetensutveckling \u2014 Introduktionssamtal',
    introInviteGreeting: 'Tack f\u00f6r att du bokat ett introduktionssamtal \u2014 jag ser fram emot v\u00e5rt samtal!',
    introInviteBody: 'Vi har ett avslappnat 30-minuterssamtal om ditt arbetsfl\u00f6de och hur AI kan hj\u00e4lpa. Ingen f\u00f6rberedelse beh\u00f6vs.',
  },
}

function getBookingTexts(lang) {
  return BOOKING_TEXTS[lang] || BOOKING_TEXTS.en
}

function getPackageLabel(texts, pkg) {
  if (pkg === 'bundle') return texts.packageBundle
  if (pkg === 'intro') return texts.packageIntro
  return texts.packageSingle
}

function handleAvailability(e) {
  var month = (e && e.parameter && e.parameter.month) || ''
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return jsonResponse({ error: 'invalid_input', message: 'Parameter "month" must be YYYY-MM format.' })
  }

  var type = (e.parameter.type === 'intro') ? 'intro' : 'session'
  var parts = month.split('-').map(Number)
  var slotDefs = type === 'intro' ? INTRO_SLOTS : SLOTS
  var slots = buildMonthSlots(parts[0], parts[1], slotDefs)
  return jsonResponse({ slots: slots, timezone: TIMEZONE })
}

function buildMonthSlots(year, mon, slotDefs) {
  var firstDay = new Date(year, mon - 1, 1)
  var lastDay = new Date(year, mon, 0)
  var earliest = getEarliestBookableDate()
  var latest = getLatestBookableDate()

  var slots = []
  for (var d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    if (isWeekend(d)) continue
    var dateStr = formatDate(d)

    var isFriday = d.getDay() === 5
    for (var i = 0; i < slotDefs.length; i++) {
      var slot = slotDefs[i]
      if (isFriday && slot.hours >= 13) {
        slots.push({ date: dateStr, time: slot.time, available: false })
        continue
      }
      var range = slotTimeRange(d, slot)
      var isBookable = range.start >= earliest && range.start <= latest
      var available = isBookable && !isSlotBusy(range.start, range.end)
      slots.push({ date: dateStr, time: slot.time, available: available })
    }
  }
  return slots
}

function getSlotsForPackage(pkg) {
  return pkg === 'intro' ? INTRO_SLOTS : SLOTS
}

function handleBooking(body) {
  var validationError = validateBookingInput(body)
  if (validationError) return jsonResponse(validationError)

  var slotDefs = getSlotsForPackage(body.package)
  var slot = slotDefs.find(function (s) { return s.time === body.time })
  var parts = body.date.split('-').map(Number)
  var range = slotTimeRange(new Date(parts[0], parts[1] - 1, parts[2]), slot)

  return createBooking(range.start, range.end, body)
}

function validateBookingInput(body) {
  var date = body.date, time = body.time, email = body.email, message = body.message
  var pkg = body.package || 'single'
  var isIntro = pkg === 'intro'

  if (!date || !time || !email || !message) {
    return { error: 'invalid_input', message: 'All fields are required.' }
  }
  if (!isIntro) {
    if (!body.phone || !body.linkedin) {
      return { error: 'invalid_input', message: 'All fields are required.' }
    }
    if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(body.linkedin)) {
      return { error: 'invalid_input', message: 'Please enter a valid LinkedIn profile URL.' }
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'invalid_input', message: 'Date must be YYYY-MM-DD format.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'invalid_input', message: 'Invalid email address.' }
  }

  var slotDefs = getSlotsForPackage(pkg)
  var slotDef = slotDefs.find(function (s) { return s.time === time })
  if (!slotDef) {
    var validTimes = slotDefs.map(function (s) { return '"' + s.time + '"' }).join(', ')
    return { error: 'invalid_input', message: 'Invalid time. Valid times: ' + validTimes + '.' }
  }

  var parts = date.split('-').map(Number)
  var slotStart = new Date(parts[0], parts[1] - 1, parts[2], slotDef.hours, slotDef.minutes)

  if (isWeekend(slotStart)) {
    return { error: 'invalid_input', message: 'Bookings are only available on weekdays.' }
  }
  if (slotStart.getDay() === 5 && slotDef.hours >= 13) {
    return { error: 'invalid_input', message: 'Friday afternoons are not available for booking.' }
  }
  if (slotStart < getEarliestBookableDate() || slotStart > getLatestBookableDate()) {
    return { error: 'invalid_input', message: 'Selected date is outside the bookable window.' }
  }
  return null
}

function createBooking(slotStart, slotEnd, body) {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(10000)) {
    return jsonResponse({ error: 'busy', message: 'Server is busy. Please try again.' })
  }

  var texts = getBookingTexts(body.lang)

  try {
    if (isSlotBusy(slotStart, slotEnd)) {
      return jsonResponse({ error: 'slot_taken', message: texts.slotTaken })
    }

    var pkg = body.package || 'single'
    var packageLabel = getPackageLabel(texts, pkg)
    var eventTitle = pkg === 'intro' ? texts.introEventTitle : (pkg === 'bundle' ? texts.eventTitle + ' [1/3]' : texts.eventTitle)

    var descriptionLines
    if (pkg === 'intro') {
      descriptionLines = [
        texts.introInviteGreeting,
        '',
        texts.introInviteBody,
        '',
        texts.inviteClosing,
      ]
    } else {
      descriptionLines = [
        texts.inviteGreeting,
        '',
        texts.invitePrep,
        '',
        texts.inviteClosing,
      ]
    }

    descriptionLines.push('', '---', '', 'Package: ' + packageLabel, 'Client email: ' + body.email)
    if (body.phone) descriptionLines.push('Client phone: ' + body.phone)
    if (body.linkedin) descriptionLines.push('LinkedIn: ' + body.linkedin)
    descriptionLines.push('', 'What they want from the session:', body.message, '', 'Booked via danielgrahn.com on ' + formatDate(new Date()))

    var description = descriptionLines.join('\n')

    var event = CalendarApp.getDefaultCalendar().createEvent(eventTitle, slotStart, slotEnd, {
      description: description,
    })
    event.setVisibility(CalendarApp.Visibility.PRIVATE)
    event.addGuest(body.email)
    event.setGuestsCanSeeGuests(false)

    try { notifyOwner(body, slotStart, slotEnd) } catch (_) {}

    return jsonResponse({ success: true, message: texts.bookingConfirmed })
  } finally {
    lock.releaseLock()
  }
}

function formatTime(date) {
  var h = String(date.getHours()).padStart(2, '0')
  var m = String(date.getMinutes()).padStart(2, '0')
  return h + ':' + m
}

function notifyOwner(body, slotStart, slotEnd) {
  var dateStr = formatDate(slotStart)
  var timeStr = formatTime(slotStart) + '\u2013' + formatTime(slotEnd)
  var texts = getBookingTexts(body.lang)
  var pkg = body.package || 'single'
  var packageLabel = getPackageLabel(texts, pkg)

  var subject = 'New AI Competence Development booking (' + packageLabel + '): ' + dateStr + ' ' + timeStr

  var lines = [
    'New AI Competence Development session booked!',
    '',
    'Package: ' + packageLabel,
    'Date: ' + dateStr,
    'Time: ' + timeStr,
    'Email: ' + body.email,
  ]
  if (body.phone) lines.push('Phone: ' + body.phone)
  if (body.linkedin) lines.push('LinkedIn: ' + body.linkedin)
  lines.push('', 'Session goals:', body.message)

  MailApp.sendEmail('dangrahn@gmail.com', subject, lines.join('\n'))
}

function isSlotBusy(start, end) {
  var calendars = [CalendarApp.getDefaultCalendar()]
  for (var i = 0; i < BUSY_CALENDARS.length; i++) {
    var cal = CalendarApp.getCalendarById(BUSY_CALENDARS[i])
    if (cal) calendars.push(cal)
  }
  for (var c = 0; c < calendars.length; c++) {
    var events = calendars[c].getEvents(start, end)
    for (var e = 0; e < events.length; e++) {
      if (events[e].getTransparency() === CalendarApp.EventTransparency.OPAQUE) return true
    }
  }
  return false
}

function slotTimeRange(date, slot) {
  var start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), slot.hours, slot.minutes)
  var end = new Date(start.getTime() + slot.duration * 60 * 60 * 1000)
  return { start: start, end: end }
}

function isWeekend(date) {
  var day = date.getDay()
  return day === 0 || day === 6
}

function getEarliestBookableDate() {
  var now = new Date()
  var earliest = new Date(now.getTime())
  var daysAdded = 0
  while (daysAdded < MIN_LEAD_DAYS) {
    earliest.setDate(earliest.getDate() + 1)
    if (!isWeekend(earliest)) daysAdded++
  }
  earliest.setHours(0, 0, 0, 0)
  return earliest
}

function getLatestBookableDate() {
  var now = new Date()
  var latest = new Date(now.getTime())
  latest.setDate(latest.getDate() + MAX_WEEKS_AHEAD * 7)
  latest.setHours(23, 59, 59, 999)
  return latest
}

function formatDate(d) {
  var year = d.getFullYear()
  var month = String(d.getMonth() + 1).padStart(2, '0')
  var day = String(d.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON)
}
