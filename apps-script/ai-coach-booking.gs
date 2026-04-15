// Google Apps Script backend for the AI Coach booking page on danielgrahn.com.
// Deployed as a web app, it exposes availability from the primary Google Calendar
// and creates coaching session bookings with email notifications.

const TIMEZONE = 'Europe/Stockholm'
const SLOTS = [
  { time: '09:00', hours: 9, minutes: 0, duration: 3 },
  { time: '13:00', hours: 13, minutes: 0, duration: 3 },
]
const MIN_LEAD_DAYS = 5
const MAX_WEEKS_AHEAD = 6

function handleAvailability(e) {
  const month = (e && e.parameter && e.parameter.month) || ''
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return jsonResponse({ error: 'invalid_input', message: 'Parameter "month" must be YYYY-MM format.' })
  }

  const [year, mon] = month.split('-').map(Number)
  const slots = buildMonthSlots(year, mon)
  return jsonResponse({ slots, timezone: TIMEZONE })
}

function buildMonthSlots(year, mon) {
  const firstDay = new Date(year, mon - 1, 1)
  const lastDay = new Date(year, mon, 0)
  const calendar = CalendarApp.getDefaultCalendar()
  const earliest = getEarliestBookableDate()
  const latest = getLatestBookableDate()

  const slots = []
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    if (isWeekend(d)) continue
    const dateStr = formatDate(d)

    var isFriday = d.getDay() === 5
    for (const slot of SLOTS) {
      if (isFriday && slot.time === '13:00') {
        slots.push({ date: dateStr, time: slot.time, available: false })
        continue
      }
      const { start, end } = slotTimeRange(d, slot)
      const isBookable = start >= earliest && start <= latest
      const available = isBookable && calendar.getEvents(start, end).length === 0
      slots.push({ date: dateStr, time: slot.time, available })
    }
  }
  return slots
}

function handleBooking(body) {
  const validationError = validateBookingInput(body)
  if (validationError) return jsonResponse(validationError)

  const slot = SLOTS.find(function (s) { return s.time === body.time })
  const [year, month, day] = body.date.split('-').map(Number)
  const { start, end } = slotTimeRange(new Date(year, month - 1, day), slot)

  return createBooking(start, end, body)
}

function validateBookingInput(body) {
  var date = body.date, time = body.time, email = body.email, phone = body.phone, message = body.message, linkedin = body.linkedin

  if (!date || !time || !email || !phone || !message || !linkedin) {
    return { error: 'invalid_input', message: 'All fields are required.' }
  }
  if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//.test(linkedin)) {
    return { error: 'invalid_input', message: 'Please enter a valid LinkedIn profile URL.' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'invalid_input', message: 'Date must be YYYY-MM-DD format.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'invalid_input', message: 'Invalid email address.' }
  }
  if (!SLOTS.find(function (s) { return s.time === time })) {
    return { error: 'invalid_input', message: 'Time must be "09:00" or "13:00".' }
  }

  var parts = date.split('-').map(Number)
  var slotDef = SLOTS.find(function (s) { return s.time === time })
  var slotStart = new Date(parts[0], parts[1] - 1, parts[2], slotDef.hours, slotDef.minutes)

  if (isWeekend(slotStart)) {
    return { error: 'invalid_input', message: 'Bookings are only available on weekdays.' }
  }
  if (slotStart.getDay() === 5 && time === '13:00') {
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

  try {
    var calendar = CalendarApp.getDefaultCalendar()
    if (calendar.getEvents(slotStart, slotEnd).length > 0) {
      return jsonResponse({ error: 'slot_taken', message: 'This slot was just booked. Please select another.' })
    }

    var description = [
      "I'm glad you booked a coaching session and look forward to our meeting!",
      '',
      'Before our session you will receive a pre-interview questionnaire to fill in. This is the only preparation and it only takes 5 minutes.',
      '',
      'Looking forward to our meeting and to helping you leverage AI in your daily work!',
      '',
      '---',
      '',
      'Client email: ' + body.email,
      'Client phone: ' + body.phone,
      'LinkedIn: ' + body.linkedin,
      '',
      'What they want from the session:',
      body.message,
      '',
      'Booked via danielgrahn.com on ' + formatDate(new Date()),
    ].join('\n')

    var event = calendar.createEvent('AI Coach Session', slotStart, slotEnd, {
      description: description,
    })
    event.setVisibility(CalendarApp.Visibility.PRIVATE)
    event.addGuest(body.email)
    event.setGuestsCanSeeGuests(false)

    try { notifyOwner(body, slotStart, slotEnd) } catch (_) {}

    return jsonResponse({ success: true, message: 'Booking confirmed.' })
  } finally {
    lock.releaseLock()
  }
}

function notifyOwner(body, slotStart, slotEnd) {
  var dateStr = formatDate(slotStart)
  var timeStr = slotStart.getHours() + ':00–' + slotEnd.getHours() + ':00'

  var subject = 'New AI Coach booking: ' + dateStr + ' ' + timeStr

  var emailBody = [
    'New AI coaching session booked!',
    '',
    'Date: ' + dateStr,
    'Time: ' + timeStr,
    'Email: ' + body.email,
    'Phone: ' + body.phone,
    'LinkedIn: ' + body.linkedin,
    '',
    'Session goals:',
    body.message,
  ].join('\n')

  MailApp.sendEmail('dangrahn@gmail.com', subject, emailBody)
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
